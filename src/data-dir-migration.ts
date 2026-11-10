/**
 * One-time forward migration of everything this server keeps on disk, across the
 * data-directory rename (`.better-email-mcp` -> `.email`, hull slug
 * `better-email` -> `email`).
 *
 * Two kinds of state move:
 *
 *  1. `tokens.json` - the saved Outlook grants, written by this server under
 *     `<base>/.better-email-mcp/` where the base is `EMAIL_DATA_DIR` or `$HOME`.
 *     It is copied byte-for-byte to `<base>/.email/tokens.json` with mode 0600
 *     and verified before the run reports success.
 *  2. hull's per-plugin credential blob (`config.json` + its machine key) that
 *     the CLI built-ins (`config`, `status`, `doctor`) read. Every release so far
 *     passed the slug `better-email`, so it lives in `~/.better-email/`; hull now
 *     reads `~/.email/`. The payload is decrypted and re-encrypted through hull
 *     rather than the directory being renamed, because hull derives a single-user
 *     machine key per directory and a copy is the only form that is verified.
 *     (hull's own read-only fallbacks still cover `~/.better-email-mcp/`.)
 *
 * Rules this module keeps, because it moves live credentials:
 *
 *  - a target that already exists is never replaced: the current store wins;
 *  - nothing is deleted - the pre-rename files stay exactly as they were, so a
 *    failed or refused migration cannot lose a token;
 *  - every copy/write is read back and compared before it is reported;
 *  - an unreadable or malformed pre-rename path raises `StoreMigrationError`
 *    instead of being treated as "not configured", which would silently ask the
 *    user to authenticate again;
 *  - neither a report nor an error message ever contains a credential value.
 */

import type { Stats } from 'node:fs'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { credPath, dataDirCandidates, PerPluginStore } from '@n24q02m/hull/storage'
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, LEGACY_STORE_PLUGIN, resolveBaseDir, STORE_PLUGIN } from './data-dir.js'

/** One path copied forward out of the pre-rename layout. */
export interface MigratedPath {
  /** Pre-rename file the data was read from. */
  source: string
  /** Current-layout file it was copied into. */
  target: string
}

/** What a migration run did, or deliberately did not do. */
export interface MigrationReport {
  /** Paths copied into the current layout by this run. */
  migrated: MigratedPath[]
  /** Current-layout paths left untouched because they already exist. */
  kept: string[]
}

/**
 * A pre-rename path that cannot be read, or a migrated copy that cannot be
 * written or read back. Messages name paths, never credential values.
 */
export class StoreMigrationError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message)
    this.name = 'StoreMigrationError'
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? 'unknown error'
}

/** The pre-rename `tokens.json`, or null when there is none. */
function legacyTokensSource(): string | null {
  const source = join(resolveBaseDir(), LEGACY_DATA_DIR_NAME, 'tokens.json')
  let info: Stats
  try {
    info = statSync(source)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return null
    throw new StoreMigrationError(
      source,
      `Cannot read the previous token file ${source} (${code}). Fix its permissions or move it aside, then start again: nothing was migrated and no credential was changed.`
    )
  }
  if (!info.isFile()) {
    throw new StoreMigrationError(
      source,
      `${source} is not a file, so the saved Outlook tokens cannot be read. Move it aside, then start again: nothing was migrated.`
    )
  }
  return source
}

/** Copy the saved Outlook tokens into the current layout, once. */
function migrateTokens(report: MigrationReport): void {
  const target = join(resolveBaseDir(), DATA_DIR_NAME, 'tokens.json')
  if (existsSync(target)) {
    report.kept.push(target)
    return
  }
  const source = legacyTokensSource()
  if (source === null) return

  // Proven readable before anything is written, so an unreadable file is
  // reported as the source it is instead of as a copy failure on the target.
  try {
    closeSync(openSync(source, 'r'))
  } catch (error) {
    throw new StoreMigrationError(
      source,
      `Cannot read the previous token file ${source} (${errorCode(error)}). Fix its permissions or move it aside, then start again: nothing was migrated and no credential was changed.`
    )
  }

  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    // COPYFILE_EXCL keeps the "current store wins" rule even against a file that
    // appeared between the check above and this call.
    copyFileSync(source, target, fsConstants.COPYFILE_EXCL)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') {
      report.kept.push(target)
      return
    }
    throw new StoreMigrationError(
      target,
      `Cannot copy the saved Outlook tokens to ${target} (${code}). The previous file ${source} was left untouched.`
    )
  }

  let verified = false
  try {
    if (process.platform !== 'win32') {
      // Same mode the writer uses; copyFileSync does not promise it.
      chmodSync(target, 0o600)
    }
    verified = readFileSync(source).equals(readFileSync(target))
  } catch {
    verified = false
  }
  if (!verified) {
    // Remove the copy that could not be verified so the next start retries;
    // the pre-rename file is untouched either way.
    rmSync(target, { force: true })
    throw new StoreMigrationError(
      target,
      `Copied the saved Outlook tokens to ${target} but could not read them back identically. The previous file ${source} was left untouched.`
    )
  }

  report.migrated.push({ source, target })
}

/** First pre-rename directory holding a readable hull credential blob, in hull's order. */
function legacyHullSource(): string | null {
  for (const { dir } of dataDirCandidates(LEGACY_STORE_PLUGIN)) {
    let info: Stats
    try {
      info = statSync(dir)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') continue
      throw new StoreMigrationError(
        dir,
        `Cannot read the previous credential directory ${dir} (${code}). Fix its permissions or move it aside, then start again: nothing was migrated and no credential was changed.`
      )
    }
    if (!info.isDirectory()) {
      throw new StoreMigrationError(
        dir,
        `${dir} is not a directory, so the saved credential inside it cannot be read. Move it aside, then start again: nothing was migrated.`
      )
    }
    // Reading the blob proves the directory is traversable and the file is
    // readable; `existsSync` alone reports "absent" for a directory this process
    // may not enter, which would look like "no credentials" and lose them.
    try {
      readFileSync(join(dir, 'config.json'))
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') continue
      throw new StoreMigrationError(
        dir,
        `Cannot read the saved credential in ${dir} (${code}). Fix its permissions or move it aside, then start again: nothing was migrated and no credential was changed.`
      )
    }
    return dir
  }
  return null
}

/** Re-encrypt hull's credential blob for the current slug, once. */
async function migrateHullCredential(report: MigrationReport): Promise<void> {
  const target = credPath(STORE_PLUGIN, null)
  if (existsSync(target)) {
    report.kept.push(target)
    return
  }
  const source = legacyHullSource()
  if (source === null) return

  let payload: Record<string, unknown> | null
  try {
    payload = await new PerPluginStore(LEGACY_STORE_PLUGIN).load()
  } catch (error) {
    throw new StoreMigrationError(
      source,
      `Cannot read the saved credential in ${source} (${errorCode(error)}). Nothing was migrated and the previous store was left untouched.`
    )
  }
  // Nothing saved there (or hull already reported it as corrupt).
  if (payload === null) return

  const store = new PerPluginStore(STORE_PLUGIN)
  try {
    await store.save(payload)
  } catch (error) {
    throw new StoreMigrationError(
      target,
      `Cannot write the migrated credential to ${target} (${errorCode(error)}). The previous store in ${source} was left untouched.`
    )
  }

  let readBack: Record<string, unknown> | null = null
  try {
    readBack = await store.load()
  } catch {
    readBack = null
  }
  if (!isDeepStrictEqual(readBack, payload)) {
    throw new StoreMigrationError(
      target,
      `Wrote ${target} but reading it back did not return the migrated credential. The previous store in ${source} was left untouched.`
    )
  }

  report.migrated.push({ source, target })
}

async function runMigration(): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], kept: [] }
  // Tokens first: they are the state a user notices, and the hull blob lives in a
  // different directory, so one failing never depends on the other.
  migrateTokens(report)
  await migrateHullCredential(report)
  return report
}

let inFlight: Promise<MigrationReport> | null = null

/**
 * Migrate the pre-rename state, at most once per process.
 *
 * Call before the first credential read (startup does). Idempotent by
 * construction: every target that already exists wins. A failure is returned to
 * every later caller unchanged - the same unreadable path stays unreadable for
 * the life of the process, so a server cannot come up half-migrated.
 */
export function migrateLegacyData(): Promise<MigrationReport> {
  inFlight ??= runMigration()
  return inFlight
}

/** Forget the single-flight result so a test can run the migration again. */
export function resetStoreMigrationForTesting(): void {
  inFlight = null
}
