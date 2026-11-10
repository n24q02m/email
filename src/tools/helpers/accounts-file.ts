/**
 * Accounts file: the file-based multi-account credential source.
 *
 * One TOML table per mailbox, the same shape hull's `users.toml` uses for its
 * multi-user token table:
 *
 *     [accounts.work]
 *     email = "me@company.com"
 *     password = "app-password"
 *     imap_host = "imap.company.com"   # optional: skip provider auto-discovery
 *     imap_port = 993                  # optional
 *     smtp_host = "smtp.company.com"   # optional
 *     smtp_port = 587                  # optional
 *     smtp_security = "starttls"       # optional: tls | ssl | starttls | none
 *     enabled = true                   # optional; false keeps the row but skips it
 *
 * The file is additive, not a replacement: `EMAIL_CREDENTIALS` keeps working
 * exactly as before. When a file is selected it wins over the env vars, so a
 * multi-account deployment has one place that defines the accounts.
 *
 * Validation mirrors `users.toml`: unknown keys, a duplicate mailbox, an empty
 * file and a file with no `[accounts.<id>]` table are all errors that name the
 * file, so a typo never degrades into "no accounts configured".
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse, TomlError } from 'smol-toml'
import { resolveBaseDir } from '../../data-dir.js'
import type { SmtpSecurity } from './config.js'
import { EmailMCPError } from './errors.js'

/** Env var naming the accounts file, or `off`/`none` to disable the file. */
export const ACCOUNTS_FILE_ENV = 'EMAIL_ACCOUNTS_FILE'

/** File name looked up in the data directory when the env var is unset. */
export const ACCOUNTS_FILE_NAME = 'accounts.toml'

/**
 * Data directory the file lives in when `EMAIL_ACCOUNTS_FILE` is unset. This is
 * the same directory the rest of the server's state moves to (`resolveDataDir`
 * follows the same name once the data-dir rename lands), so one backup covers
 * tokens and accounts.
 */
const ACCOUNTS_DIR_NAME = '.email'

/** Values that turn the file off instead of naming a path. */
const DISABLED_VALUES: Record<string, true> = { off: true, none: true, false: true, '0': true }

/** Keys allowed inside one `[accounts.<id>]` table. */
const ACCOUNT_KEYS = [
  'email',
  'password',
  'imap_host',
  'imap_port',
  'smtp_host',
  'smtp_port',
  'smtp_security',
  'enabled'
] as const

const ACCOUNT_KEY_SET: Record<string, true> = Object.fromEntries(ACCOUNT_KEYS.map((key) => [key, true]))

const SMTP_SECURITY_VALUES: Record<SmtpSecurity, true> = {
  tls: true,
  ssl: true,
  starttls: true,
  none: true
}

/** One validated account row, still free of provider/server resolution. */
export interface AccountsFileEntry {
  /** Table key under `[accounts.<id>]`; becomes the account id. */
  id: string
  email: string
  password: string
  /** `false` only when the row says `enabled = false`. */
  enabled: boolean
  imapHost?: string
  imapPort?: number
  smtpHost?: string
  smtpPort?: number
  smtpSecurity?: SmtpSecurity
}

/** Where the accounts file is, and whether the operator named it. */
export interface AccountsFileSelection {
  path: string
  explicit: boolean
}

function isTable(value: unknown): value is Record<string, unknown> {
  // TOML tables parse to plain (null-prototype) objects; arrays and dates do not
  // match this check, so a bare list is rejected where a table is required.
  return Object.prototype.toString.call(value) === '[object Object]'
}

function invalid(message: string, suggestion?: string): EmailMCPError {
  return new EmailMCPError(message, 'ACCOUNTS_FILE_INVALID', suggestion)
}

/**
 * Resolve the accounts-file location.
 *
 * - `EMAIL_ACCOUNTS_FILE` naming a path: that path, resolved against `$HOME`
 *   when relative (an absolute path is taken as-is).
 * - `EMAIL_ACCOUNTS_FILE` set to `off`/`none`/`false`/`0`: the file is disabled
 *   and only the env vars are used.
 * - unset or empty: `<data dir>/accounts.toml` under the home directory.
 */
export function resolveAccountsFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): AccountsFileSelection | null {
  const raw = env[ACCOUNTS_FILE_ENV]?.trim()
  if (raw) {
    if (DISABLED_VALUES[raw.toLowerCase()]) return null
    if (raw.includes('\0')) {
      throw invalid(`${ACCOUNTS_FILE_ENV} must not contain a NUL byte`)
    }
    return { path: resolve(home, raw), explicit: true }
  }
  return { path: join(resolveBaseDir(env, home), ACCOUNTS_DIR_NAME, ACCOUNTS_FILE_NAME), explicit: false }
}

/**
 * The accounts file to read, or `null` when none is configured.
 *
 * An explicitly named file that does not exist throws: a mistyped path is a
 * configuration error, not a reason to silently fall back to the env vars.
 * The default path is optional by design, so a missing default file simply
 * means "env-var configuration".
 */
export async function discoverAccountsFile(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<AccountsFileSelection | null> {
  const selection = resolveAccountsFilePath(env, home)
  if (!selection) return null
  if (selection.explicit) return selection
  // A missing or unreadable default file simply means "env-var configuration".
  const defaultFileIsPresent = await stat(selection.path).then(
    (info) => info.isFile(),
    () => false
  )
  return defaultFileIsPresent ? selection : null
}

/**
 * Parse and validate accounts-file text.
 *
 * Throws `AccountsFileError`-shaped `EmailMCPError`s (`ACCOUNTS_FILE_INVALID`)
 * for anything that would otherwise configure the server wrongly: bad TOML, an
 * empty file, no account tables, unknown keys, a duplicate mailbox, a missing
 * required field or an out-of-range port.
 */
export function parseAccountsFile(text: string, path: string): AccountsFileEntry[] {
  const who = `accounts file ${path}`

  if (!text.trim()) {
    throw invalid(
      `${who} is empty`,
      'Add at least one [accounts.<id>] table with email and password, or unset EMAIL_ACCOUNTS_FILE'
    )
  }

  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    const reason = error instanceof TomlError ? error.message : String(error)
    throw invalid(`${who} is not valid TOML`, reason)
  }

  if (!isTable(raw)) {
    throw invalid(`${who} must be a TOML table with an [accounts.<id>] section`)
  }

  const unknownTopLevel = Object.keys(raw).filter((key) => key !== 'accounts')
  if (unknownTopLevel.length > 0) {
    throw invalid(`${who} has unknown key(s): ${unknownTopLevel.join(', ')}`, 'Only [accounts.<id>] tables are allowed')
  }

  const table = raw.accounts
  if (!isTable(table) || Object.keys(table).length === 0) {
    throw invalid(
      `${who} must contain at least one [accounts.<id>] table`,
      'Add [accounts.work] with email and password'
    )
  }

  const entries: AccountsFileEntry[] = []
  const seenEmails = new Map<string, string>()

  for (const [key, value] of Object.entries(table)) {
    const entry = parseAccountEntry(key, value, who)
    const lowerEmail = entry.email.toLowerCase()
    const duplicateOf = seenEmails.get(lowerEmail)
    if (duplicateOf !== undefined) {
      throw invalid(
        `${who}: duplicate email ${entry.email} in accounts.${duplicateOf} and accounts.${entry.id}`,
        'Each mailbox appears once; use a distinct email per account'
      )
    }
    seenEmails.set(lowerEmail, entry.id)
    entries.push(entry)
  }

  return entries
}

function requireString(table: Record<string, unknown>, field: string, who: string): string {
  const value = table[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${who}: ${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(table: Record<string, unknown>, field: string, who: string): string | undefined {
  if (!Object.hasOwn(table, field)) return undefined
  const value = table[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${who}: ${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalPort(table: Record<string, unknown>, field: string, who: string): number | undefined {
  if (!Object.hasOwn(table, field)) return undefined
  const value = table[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw invalid(`${who}: ${field} must be an integer between 1 and 65535`)
  }
  return value
}

function parseAccountEntry(key: string, value: unknown, fileWho: string): AccountsFileEntry {
  const id = key.trim()
  if (!id) {
    throw invalid(`${fileWho}: an [accounts.<id>] table has an empty id`, 'Use a name such as [accounts.work]')
  }
  const who = `${fileWho}: accounts.${id}`

  if (!isTable(value)) {
    throw invalid(`${who} must be a table`, 'Write [accounts.<id>] with email and password keys')
  }

  const unknownKeys = Object.keys(value).filter((field) => !ACCOUNT_KEY_SET[field])
  if (unknownKeys.length > 0) {
    throw invalid(`${who} has unknown key(s): ${unknownKeys.join(', ')}`, `Allowed keys: ${ACCOUNT_KEYS.join(', ')}`)
  }

  if (!Object.hasOwn(value, 'email')) {
    throw invalid(`${who}: email is required`)
  }
  const email = requireString(value, 'email', who)
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw invalid(`${who}: email "${email}" is not an address`)
  }

  if (!Object.hasOwn(value, 'password')) {
    throw invalid(
      `${who}: password is required`,
      'Use an app password; Outlook accounts run `email auth outlook <address>`'
    )
  }
  const password = requireString(value, 'password', who)

  let enabled = true
  if (Object.hasOwn(value, 'enabled')) {
    const rawEnabled = value.enabled
    if (typeof rawEnabled !== 'boolean') {
      throw invalid(`${who}: enabled must be true or false`)
    }
    enabled = rawEnabled
  }

  const imapHost = optionalString(value, 'imap_host', who)
  const imapPort = optionalPort(value, 'imap_port', who)
  const smtpHost = optionalString(value, 'smtp_host', who)
  const smtpPort = optionalPort(value, 'smtp_port', who)

  let smtpSecurity: SmtpSecurity | undefined
  const rawSecurity = optionalString(value, 'smtp_security', who)
  if (rawSecurity !== undefined) {
    const normalized = rawSecurity.toLowerCase()
    if (!SMTP_SECURITY_VALUES[normalized as SmtpSecurity]) {
      throw invalid(
        `${who}: smtp_security must be one of ${Object.keys(SMTP_SECURITY_VALUES).join(', ')}`,
        `Got "${rawSecurity}"`
      )
    }
    smtpSecurity = normalized as SmtpSecurity
  }

  if (imapPort !== undefined && imapHost === undefined) {
    throw invalid(`${who}: imap_port requires imap_host`)
  }
  if ((smtpPort !== undefined || smtpSecurity !== undefined) && smtpHost === undefined) {
    throw invalid(`${who}: smtp_port and smtp_security require smtp_host`)
  }

  return {
    id,
    email,
    password,
    enabled,
    ...(imapHost === undefined ? {} : { imapHost }),
    ...(imapPort === undefined ? {} : { imapPort }),
    ...(smtpHost === undefined ? {} : { smtpHost }),
    ...(smtpPort === undefined ? {} : { smtpPort }),
    ...(smtpSecurity === undefined ? {} : { smtpSecurity })
  }
}

/** Read and validate the accounts file at `path`. */
export async function readAccountsFile(path: string): Promise<AccountsFileEntry[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new EmailMCPError(
        `Accounts file not found: ${path}`,
        'ACCOUNTS_FILE_MISSING',
        `Create ${path} with one [accounts.<id>] table per mailbox, unset ${ACCOUNTS_FILE_ENV} to use EMAIL_CREDENTIALS, or set ${ACCOUNTS_FILE_ENV}=off to disable the file`
      )
    }
    throw invalid(`Accounts file could not be read: ${path}`, code ? `filesystem error ${code}` : undefined)
  }
  return parseAccountsFile(text, path)
}
