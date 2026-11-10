/**
 * Data directory for this server, chosen the way the telegram server chooses
 * its own (single resolver, one base dir, an env override, and a guard that a
 * hostile value cannot walk out of the base).
 *
 * Layout: everything this server persists lives under `<base>/.email/`
 * (`tokens.json` for the saved Outlook grants, plus the `config.json` hull's
 * per-plugin credential store writes for the CLI built-ins). The directory is
 * named after the short product slug, the same one hull uses. A release before
 * the rename wrote `<base>/.better-email-mcp/`; src/data-dir-migration.ts copies
 * that forward on startup, so saved tokens stay readable.
 *
 * `EMAIL_DATA_DIR` replaces the base outright, so a container can mount a
 * single volume: `-e EMAIL_DATA_DIR=/data` -> `/data/.email/tokens.json`.
 *
 * Guard: a RELATIVE value is resolved against `$HOME` and must stay inside it,
 * so `..`, `../..`, `..\\..` and NUL bytes cannot leave the base. An ABSOLUTE
 * value is an explicit operator choice (a mounted volume) and is normalized and
 * taken as-is. Empty or whitespace-only means "use the default", because plugin
 * manifests set unset env vars to `""`.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Env var that replaces the base directory. */
export const DATA_DIR_ENV = 'EMAIL_DATA_DIR'

/** Plugin slug hull keys the per-plugin credential store off (`<base>/.email/`). */
export const STORE_PLUGIN = 'email'

/** Slug every release before the rename passed to hull; a migration source only. */
export const LEGACY_STORE_PLUGIN = 'better-email'

/** Directory name this server owns under the base (hull's `.<STORE_PLUGIN>`). */
export const DATA_DIR_NAME = `.${STORE_PLUGIN}`

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

/** Absolute directory holding this server's own files (`tokens.json`). */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(resolveBaseDir(env, home), DATA_DIR_NAME)
}
