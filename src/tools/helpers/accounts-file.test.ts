import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNTS_FILE_ENV,
  discoverAccountsFile,
  parseAccountsFile,
  readAccountsFile,
  resolveAccountsFilePath
} from './accounts-file.js'
import { loadConfig } from './config.js'
import { EmailMCPError } from './errors.js'

const HOME = join(tmpdir(), 'email-accounts-home')

function expectInvalid(fn: () => unknown, ...fragments: string[]): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(EmailMCPError)
    const emailError = error as EmailMCPError
    expect(emailError.code).toBe('ACCOUNTS_FILE_INVALID')
    for (const fragment of fragments) {
      expect(`${emailError.message} ${emailError.suggestion ?? ''}`).toContain(fragment)
    }
    return
  }
  throw new Error('expected an ACCOUNTS_FILE_INVALID error')
}

const VALID = `
[accounts.work]
email = "me@company.com"
password = "app-password"
imap_host = "imap.company.com"
imap_port = 993
smtp_host = "smtp.company.com"
smtp_port = 587
smtp_security = "starttls"

[accounts.personal]
email = "me@gmail.com"
password = "gmail-app-password"
`

describe('parseAccountsFile', () => {
  it('parses one entry per [accounts.<id>] table', () => {
    const entries = parseAccountsFile(VALID, '/tmp/accounts.toml')

    expect(entries).toEqual([
      {
        id: 'work',
        email: 'me@company.com',
        password: 'app-password',
        enabled: true,
        imapHost: 'imap.company.com',
        imapPort: 993,
        smtpHost: 'smtp.company.com',
        smtpPort: 587,
        smtpSecurity: 'starttls'
      },
      { id: 'personal', email: 'me@gmail.com', password: 'gmail-app-password', enabled: true }
    ])
  })

  it('keeps enabled = false as an explicit value', () => {
    const [entry] = parseAccountsFile(
      '[accounts.a]\nemail = "a@x.com"\npassword = "p"\nenabled = false\n',
      '/tmp/accounts.toml'
    )
    expect(entry!.enabled).toBe(false)
  })

  it('rejects an empty file with the file name', () => {
    expectInvalid(() => parseAccountsFile('   \n\t\n', '/tmp/accounts.toml'), '/tmp/accounts.toml', 'is empty')
  })

  it('rejects invalid TOML with the parser reason', () => {
    expectInvalid(
      () => parseAccountsFile('[accounts.a\nemail = ', '/tmp/accounts.toml'),
      '/tmp/accounts.toml',
      'not valid TOML'
    )
  })

  it('rejects a file with no [accounts] table', () => {
    expectInvalid(
      () => parseAccountsFile('[other.a]\nemail = "a@x.com"\n', '/tmp/accounts.toml'),
      'unknown key',
      'other'
    )
    expectInvalid(() => parseAccountsFile('[accounts]\n', '/tmp/accounts.toml'), 'at least one [accounts.<id>] table')
  })

  it('rejects a duplicate mailbox across two tables', () => {
    expectInvalid(
      () =>
        parseAccountsFile(
          '[accounts.a]\nemail = "same@x.com"\npassword = "p"\n[accounts.b]\nemail = "SAME@x.com"\npassword = "p"\n',
          '/tmp/accounts.toml'
        ),
      'duplicate email',
      'accounts.a',
      'accounts.b'
    )
  })

  it('rejects unknown keys inside a table', () => {
    expectInvalid(
      () => parseAccountsFile('[accounts.a]\nemail = "a@x.com"\npassword = "p"\nimap_port_tls = 993\n', '/tmp/a.toml'),
      'unknown key',
      'imap_port_tls',
      'Allowed keys'
    )
  })

  it('rejects unknown top-level keys', () => {
    expectInvalid(
      () => parseAccountsFile('[defaults]\nfoo = 1\n[accounts.a]\nemail = "a@x.com"\npassword = "p"\n', '/tmp/a.toml'),
      'unknown key',
      'defaults'
    )
  })

  it('requires email and password on every account', () => {
    expectInvalid(() => parseAccountsFile('[accounts.a]\npassword = "p"\n', '/tmp/a.toml'), 'email is required')
    expectInvalid(() => parseAccountsFile('[accounts.a]\nemail = "a@x.com"\n', '/tmp/a.toml'), 'password is required')
    expectInvalid(
      () => parseAccountsFile('[accounts.a]\nemail = "not-an-address"\npassword = "p"\n', '/tmp/a.toml'),
      'is not an address'
    )
    expectInvalid(
      () => parseAccountsFile('[accounts.a]\nemail = "a@x.com"\npassword = "  "\n', '/tmp/a.toml'),
      'password must be a non-empty string'
    )
  })

  it('rejects out-of-range ports and ports without a host', () => {
    expectInvalid(
      () =>
        parseAccountsFile(
          '[accounts.a]\nemail = "a@x.com"\npassword = "p"\nimap_host = "h.com"\nimap_port = 0\n',
          '/tmp/a.toml'
        ),
      'imap_port must be an integer between 1 and 65535'
    )
    expectInvalid(
      () => parseAccountsFile('[accounts.a]\nemail = "a@x.com"\npassword = "p"\nimap_port = 993\n', '/tmp/a.toml'),
      'imap_port requires imap_host'
    )
    expectInvalid(
      () => parseAccountsFile('[accounts.a]\nemail = "a@x.com"\npassword = "p"\nsmtp_port = 587\n', '/tmp/a.toml'),
      'smtp_port and smtp_security require smtp_host'
    )
  })

  it('rejects a non-boolean enabled and an unknown smtp_security', () => {
    expectInvalid(
      () => parseAccountsFile('[accounts.a]\nemail = "a@x.com"\npassword = "p"\nenabled = "yes"\n', '/tmp/a.toml'),
      'enabled must be true or false'
    )
    expectInvalid(
      () =>
        parseAccountsFile(
          '[accounts.a]\nemail = "a@x.com"\npassword = "p"\nsmtp_host = "s.com"\nsmtp_security = "plain"\n',
          '/tmp/a.toml'
        ),
      'smtp_security must be one of',
      'plain'
    )
  })

  it('parses aliases, dropping repeats and the account address', () => {
    const [entry] = parseAccountsFile(
      '[accounts.icloud]\nemail = "me@icloud.com"\npassword = "p"\naliases = ["hello@example.com", " Support@example.com ", "HELLO@example.com", "me@icloud.com"]\n',
      '/x/accounts.toml'
    )
    expect(entry!.aliases).toEqual(['hello@example.com', 'Support@example.com'])
  })

  it('omits aliases when the list is empty or absent', () => {
    const [withEmpty, without] = parseAccountsFile(
      '[accounts.a]\nemail = "a@gmail.com"\npassword = "p"\naliases = []\n\n[accounts.b]\nemail = "b@gmail.com"\npassword = "p"\n',
      '/x/accounts.toml'
    )
    expect(withEmpty).not.toHaveProperty('aliases')
    expect(without).not.toHaveProperty('aliases')
  })

  it('rejects aliases that are not a list of addresses', () => {
    expectInvalid(
      () =>
        parseAccountsFile(
          '[accounts.a]\nemail = "a@gmail.com"\npassword = "p"\naliases = "x@example.com"\n',
          '/x/a.toml'
        ),
      'accounts.a',
      'aliases must be a list'
    )
    expectInvalid(
      () =>
        parseAccountsFile(
          '[accounts.a]\nemail = "a@gmail.com"\npassword = "p"\naliases = ["not-an-address"]\n',
          '/x/a.toml'
        ),
      'not-an-address',
      'is not an address'
    )
    expectInvalid(
      () => parseAccountsFile('[accounts.a]\nemail = "a@gmail.com"\npassword = "p"\naliases = [42]\n', '/x/a.toml'),
      'is not an address'
    )
  })

  it('rejects an alias owned by another account', () => {
    expectInvalid(
      () =>
        parseAccountsFile(
          '[accounts.a]\nemail = "a@gmail.com"\npassword = "p"\naliases = ["team@example.com"]\n\n[accounts.b]\nemail = "b@gmail.com"\npassword = "p"\naliases = ["Team@example.com"]\n',
          '/x/a.toml'
        ),
      'accounts.b',
      'accounts.a'
    )
    // An alias that is another row's own address, even when that row comes later.
    expectInvalid(
      () =>
        parseAccountsFile(
          '[accounts.a]\nemail = "a@gmail.com"\npassword = "p"\naliases = ["b@gmail.com"]\n\n[accounts.b]\nemail = "b@gmail.com"\npassword = "p"\n',
          '/x/a.toml'
        ),
      'b@gmail.com',
      'accounts.b'
    )
  })

  it('rejects a row that is not a table', () => {
    expectInvalid(() => parseAccountsFile('[accounts]\na = "x"\n', '/tmp/a.toml'), 'accounts.a must be a table')
  })
})

describe('resolveAccountsFilePath', () => {
  it('defaults to the accounts file in the data directory', () => {
    expect(resolveAccountsFilePath({}, HOME)).toEqual({
      path: join(HOME, '.email', 'accounts.toml'),
      explicit: false
    })
  })

  it('honours an explicit absolute path', () => {
    const path = join(HOME, 'custom', 'mail.toml')
    expect(resolveAccountsFilePath({ [ACCOUNTS_FILE_ENV]: path }, HOME)).toEqual({ path, explicit: true })
  })

  it('resolves a relative path against the home directory', () => {
    expect(resolveAccountsFilePath({ [ACCOUNTS_FILE_ENV]: 'conf/accounts.toml' }, HOME)).toEqual({
      path: join(HOME, 'conf', 'accounts.toml'),
      explicit: true
    })
  })

  it('disables the file for off/none values', () => {
    expect(resolveAccountsFilePath({ [ACCOUNTS_FILE_ENV]: 'off' }, HOME)).toBeNull()
    expect(resolveAccountsFilePath({ [ACCOUNTS_FILE_ENV]: 'none' }, HOME)).toBeNull()
    expect(resolveAccountsFilePath({ [ACCOUNTS_FILE_ENV]: '  OFF  ' }, HOME)).toBeNull()
  })

  it('treats an empty value as unset', () => {
    expect(resolveAccountsFilePath({ [ACCOUNTS_FILE_ENV]: '   ' }, HOME)).toEqual({
      path: join(HOME, '.email', 'accounts.toml'),
      explicit: false
    })
  })

  it('follows EMAIL_DATA_DIR for the default path', () => {
    expect(resolveAccountsFilePath({ EMAIL_DATA_DIR: join(HOME, 'data') }, HOME)?.path).toBe(
      join(HOME, 'data', '.email', 'accounts.toml')
    )
  })
})

describe('discoverAccountsFile / readAccountsFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'email-accounts-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when the default file does not exist', async () => {
    expect(await discoverAccountsFile({}, join(dir, 'empty-home'))).toBeNull()
  })

  it('finds the default file once it exists', async () => {
    const path = join(dir, '.email', 'accounts.toml')
    await mkdir(join(dir, '.email'), { recursive: true })
    await writeFile(path, VALID, 'utf8')

    expect(await discoverAccountsFile({}, dir)).toEqual({ path, explicit: false })
  })

  it('keeps an explicit path even when the file is missing, so the error names it', async () => {
    const path = join(dir, 'nope', 'accounts.toml')
    expect(await discoverAccountsFile({ [ACCOUNTS_FILE_ENV]: path }, dir)).toEqual({ path, explicit: true })

    await expect(readAccountsFile(path)).rejects.toThrow(/Accounts file not found/)
    await expect(readAccountsFile(path)).rejects.toMatchObject({ code: 'ACCOUNTS_FILE_MISSING' })
    try {
      await readAccountsFile(path)
    } catch (error) {
      expect((error as EmailMCPError).message).toContain(path)
      expect((error as EmailMCPError).suggestion).toContain(ACCOUNTS_FILE_ENV)
    }
  })

  it('reads a valid file from disk', async () => {
    const path = join(dir, 'accounts.toml')
    await writeFile(path, VALID, 'utf8')
    const entries = await readAccountsFile(path)
    expect(entries.map((entry) => entry.email)).toEqual(['me@company.com', 'me@gmail.com'])
  })

  it('rejects an unreadable path with the filesystem code', async () => {
    const path = join(dir, 'accounts.toml')
    // A directory is readable as a stat target but not as a file, so this is a
    // non-ENOENT read failure rather than a missing file.
    await mkdir(path)
    await expect(readAccountsFile(path)).rejects.toMatchObject({ code: 'ACCOUNTS_FILE_INVALID' })
  })
})

describe('loadConfig with an accounts file', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'email-loadconfig-'))
    vi.stubEnv(ACCOUNTS_FILE_ENV, join(dir, 'accounts.toml'))
    vi.stubEnv('EMAIL_CREDENTIALS', '')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  it('reads accounts from the file, using the table key as the id', async () => {
    await writeFile(join(dir, 'accounts.toml'), VALID, 'utf8')

    const accounts = await loadConfig()

    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toMatchObject({
      id: 'work',
      email: 'me@company.com',
      password: 'app-password',
      imap: { host: 'imap.company.com', port: 993, secure: true },
      smtp: { host: 'smtp.company.com', port: 587, secure: false }
    })
    // Provider auto-discovery still applies when no host is given.
    expect(accounts[1]).toMatchObject({
      id: 'personal',
      email: 'me@gmail.com',
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true }
    })
  })

  it('wins over EMAIL_CREDENTIALS when both are set', async () => {
    await writeFile(join(dir, 'accounts.toml'), VALID, 'utf8')
    vi.stubEnv('EMAIL_CREDENTIALS', 'env@gmail.com:env-pass')

    const accounts = await loadConfig()

    expect(accounts.map((account) => account.email)).toEqual(['me@company.com', 'me@gmail.com'])
  })

  it('falls back to EMAIL_CREDENTIALS when no file is selected', async () => {
    vi.stubEnv(ACCOUNTS_FILE_ENV, 'off')
    vi.stubEnv('EMAIL_CREDENTIALS', 'env@gmail.com:env-pass,second@outlook.com:p2')

    const accounts = await loadConfig()

    expect(accounts.map((account) => account.email)).toEqual(['env@gmail.com', 'second@outlook.com'])
  })

  it('carries aliases through to the account', async () => {
    await writeFile(
      join(dir, 'accounts.toml'),
      '[accounts.icloud]\nemail = "me@icloud.com"\npassword = "p"\naliases = ["hello@example.com"]\n',
      'utf8'
    )

    const [account] = await loadConfig()

    expect(account).toMatchObject({ id: 'icloud', email: 'me@icloud.com', aliases: ['hello@example.com'] })
    expect(account!.smtp.host).toBe('smtp.mail.me.com')
  })

  it('carries enabled = false through to the account', async () => {
    await writeFile(
      join(dir, 'accounts.toml'),
      '[accounts.a]\nemail = "a@gmail.com"\npassword = "p"\nenabled = false\n',
      'utf8'
    )

    const accounts = await loadConfig()

    expect(accounts[0]).toMatchObject({ id: 'a', email: 'a@gmail.com', enabled: false })
  })

  it('fails closed when the named file is missing, even with EMAIL_CREDENTIALS set', async () => {
    vi.stubEnv('EMAIL_CREDENTIALS', 'env@gmail.com:env-pass')

    await expect(loadConfig()).rejects.toMatchObject({ code: 'ACCOUNTS_FILE_MISSING' })
  })

  it('names the account when its servers cannot be resolved', async () => {
    await writeFile(
      join(dir, 'accounts.toml'),
      '[accounts.custom]\nemail = "me@no-such-provider.test"\npassword = "p"\n',
      'utf8'
    )

    await expect(loadConfig()).rejects.toMatchObject({ code: 'ACCOUNTS_FILE_INVALID' })
    await expect(loadConfig()).rejects.toThrow(/accounts\.custom \(me@no-such-provider\.test\)/)
  })
})
