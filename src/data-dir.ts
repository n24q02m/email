/**
 * Data directory for this server, chosen the way the telegram server chooses
 * its own (single resolver, one base dir, an env override, and a guard that a
 * hostile value cannot walk out of the base).
 *
 * Layout: everything this server persists lives under `<base>/.n24q02m/email/`
 * (`tokens.json` for the saved Outlook grants, `accounts.toml` for mailbox
 * accounts, plus the `config.json` hull's per-plugin credential store writes
 * for the CLI built-ins; `profiles/<profile>/config.json` for named profiles).
 * The directory name is `dataDirName(STORE_PLUGIN)` from `@n24q02m/hull/storage`.
 * Earlier releases wrote `<base>/.email/` or `<base>/.better-email-mcp/`;
 * src/data-dir-migration.ts copies them forward on startup, so saved tokens
 * and accounts stay readable.
 *
 * `EMAIL_DATA_DIR` replaces the base outright, so a container can mount a
 * single volume: `-e EMAIL_DATA_DIR=/data` -> `/data/.n24q02m/email/tokens.json`.
 *
 * Guard: a RELATIVE value is resolved against `$HOME` and must stay inside it,
 * so `..`, `../..`, `..\\..` and NUL bytes cannot leave the base. An ABSOLUTE
 * value is an explicit operator choice (a mounted volume) and is normalized and
 * taken as-is. Empty or whitespace-only means "use the default", because plugin
 * manifests set unset env vars to `""`.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { dataDirName } from '@n24q02m/hull/storage'

/** Env var that replaces the base directory. */
export const DATA_DIR_ENV = 'EMAIL_DATA_DIR'

/** Plugin slug hull keys the per-plugin credential store off (`<base>/.n24q02m/email/`). */
export const STORE_PLUGIN = 'email'

/** Slug every release before the rename passed to hull; a migration source only. */
export const LEGACY_STORE_PLUGIN = 'better-email'

/** Directory name this server owns under the base (hull's `.n24q02m/<STORE_PLUGIN>`). */
export const DATA_DIR_NAME = dataDirName(STORE_PLUGIN)

/** v1 directory before the `.n24q02m/` namespace root was introduced. */
export const V1_DATA_DIR_NAME = `.${STORE_PLUGIN}`

/** Directory every release before the rename wrote its own files into. */
export const LEGACY_DATA_DIR_NAME = '.better-email-mcp'

/** A `DATA_DIR` value that would leave the base directory. */
export class DataDirEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataDirEscapeError'
  }
}

/**
 * Absolute base directory this server's state lives under: `EMAIL_DATA_DIR`
 * when set, else the home directory.
 */
export function resolveBaseDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const base = resolve(home)
  const raw = env[DATA_DIR_ENV]?.trim()
  if (!raw) return base

  if (raw.includes('\0')) {
    throw new DataDirEscapeError(`${DATA_DIR_ENV} must not contain a NUL byte`)
  }

  if (isAbsolute(raw)) return resolve(raw)

  const target = resolve(base, raw)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new DataDirEscapeError(
      `${DATA_DIR_ENV}="${raw}" escapes the base directory ${base}; use an absolute path to choose another directory`
    )
  }
  return target
}

/** Absolute directory holding this server's own files (`tokens.json`, `accounts.toml`). */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env[DATA_DIR_ENV]?.trim()) {
    return join(resolveBaseDir(env, home), DATA_DIR_NAME)
  }
  const n24Home = env.N24Q02M_HOME?.trim()
  if (n24Home) {
    return join(resolve(n24Home), STORE_PLUGIN)
  }
  const useXdg = env.N24Q02M_USE_XDG?.trim().toLowerCase()
  if (useXdg === '1' || useXdg === 'true' || useXdg === 'yes') {
    const xdg = env.XDG_CONFIG_HOME?.trim() || env.APPDATA?.trim()
    if (xdg) return join(resolve(xdg), 'n24q02m', STORE_PLUGIN)
  }
  return join(resolve(home), DATA_DIR_NAME)
}
