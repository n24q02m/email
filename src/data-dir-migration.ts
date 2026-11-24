/**
 * One-time forward migration of everything this server keeps on disk, across the
 * data-directory rename (`.better-email-mcp` -> `.email`, hull slug
 * `better-email` -> `email`).
 *
 * Two kinds of state move:
 *
 *  1. `tokens.json` and `accounts.toml` - copied byte-for-byte into `<dataDir>/`
 *     with mode 0600 and verified before the run reports success. Legacy sources
 *     are checked newest-first: `<base>/.email/` (v1) then
 *     `<base>/.better-email-mcp/` (v0).
 *  2. hull's per-plugin credential blob (`config.json` + its machine key) that
 *     the CLI built-ins (`config`, `status`, `doctor`) read, checked newest-first
 *     across legacy layouts (`~/.email/`, `~/.email-mcp/`, `~/.better-email-mcp/`,
 *     and `~/.better-email/`) and re-encrypted into `~/.n24q02m/email/`.
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
import {
  credPath,
  type DataDirLocation,
  dataDirCandidates,
  legacyDataDirs,
  PerPluginStore
} from '@n24q02m/hull/storage'
import {
  LEGACY_DATA_DIR_NAME,
  LEGACY_STORE_PLUGIN,
  resolveBaseDir,
  resolveDataDir,
  STORE_PLUGIN,
  V1_DATA_DIR_NAME
} from './data-dir.js'

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

/** Legacy locations for server-owned state files, newest-first. */
function legacyFileSource(fileName: string, label: string): string | null {
  const base = resolveBaseDir()
  const candidates = [join(base, V1_DATA_DIR_NAME, fileName), join(base, LEGACY_DATA_DIR_NAME, fileName)]
  for (const source of candidates) {
    let info: Stats
    try {
      info = statSync(source)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') continue
      throw new StoreMigrationError(
        source,
        `Cannot read the previous ${label} ${source} (${code}). Fix its permissions or move it aside, then start again: nothing was migrated and no credential was changed.`
      )
    }
    if (!info.isFile()) {
      throw new StoreMigrationError(
        source,
        `${source} is not a file, so the saved ${label} cannot be read. Move it aside, then start again: nothing was migrated.`
      )
    }
    return source
  }
  return null
}

/** Copy one legacy state file into `<dataDir>/<fileName>`, once. */
function migrateLegacyFile(fileName: string, label: string, report: MigrationReport): void {
  const target = join(resolveDataDir(), fileName)
  if (existsSync(target)) {
    report.kept.push(target)
    return
  }
  const source = legacyFileSource(fileName, label)
  if (source === null || source === target) return

  // Proven readable before anything is written, so an unreadable file is
  // reported as the source it is instead of as a copy failure on the target.
  try {
    closeSync(openSync(source, 'r'))
  } catch (error) {
    throw new StoreMigrationError(
      source,
      `Cannot read the previous ${label} ${source} (${errorCode(error)}). Fix its permissions or move it aside, then start again: nothing was migrated and no credential was changed.`
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
      `Cannot copy the saved ${label} to ${target} (${code}). The previous file ${source} was left untouched.`
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
      `Copied the saved ${label} to ${target} but could not read them back identically. The previous file ${source} was left untouched.`
    )
  }

  report.migrated.push({ source, target })
}

/** First pre-v2 directory holding a readable hull credential blob, newest-first. */
function legacyHullSource(): { dir: string; loadPlugin: string } | null {
  const candidates: Array<{ loc: DataDirLocation; loadPlugin: string }> = [
    ...legacyDataDirs(STORE_PLUGIN).map((loc) => ({ loc, loadPlugin: loc.keyPlugin })),
    ...dataDirCandidates(LEGACY_STORE_PLUGIN).map((loc) => ({ loc, loadPlugin: LEGACY_STORE_PLUGIN }))
  ]
  const seen = new Set<string>()
  for (const { loc, loadPlugin } of candidates) {
    const { dir } = loc
    if (seen.has(dir)) continue
    seen.add(dir)
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
    return { dir, loadPlugin }
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
    payload = await new PerPluginStore(source.loadPlugin).load()
  } catch (error) {
    throw new StoreMigrationError(
      source.dir,
      `Cannot read the saved credential in ${source.dir} (${errorCode(error)}). Nothing was migrated and the previous store was left untouched.`
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
      `Cannot write the migrated credential to ${target} (${errorCode(error)}). The previous store in ${source.dir} was left untouched.`
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
      `Wrote ${target} but reading it back did not return the migrated credential. The previous store in ${source.dir} was left untouched.`
    )
  }

  report.migrated.push({ source: source.dir, target })
}

async function runMigration(): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], kept: [] }
  // Tokens & accounts first: they are the state a user notices, and the hull
  // blob may come from a separate directory, so one failing never drops another.
  migrateLegacyFile('tokens.json', 'token file', report)
  migrateLegacyFile('accounts.toml', 'accounts file', report)
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
