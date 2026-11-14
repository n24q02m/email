/**
 * Per-caller credential namespaces for HTTP multi-user mode.
 *
 * In `MCP_AUTH_MODE=multi` hull's auth guard resolves every request's bearer
 * token to a user row in `users.toml` and binds that user's `namespace` for the
 * request (`currentUser()`). Everything this server persists for a caller then
 * lives under `<data dir>/users/<namespace>/`:
 *
 *   accounts.toml   the caller's mailboxes (same schema as the server-wide file)
 *   tokens.json     the caller's saved Outlook OAuth grants
 *
 * Outside multi mode (stdio, no-auth, single shared token) there is one
 * principal, so the caller namespace is `null` and the server-wide files apply.
 *
 * The namespace becomes a path segment, so it is validated against a strict
 * pattern and a value that would leave the users directory is refused.
 */

import { join } from 'node:path'
import { currentUser, localAuthContext, runWithAuthContext } from '@n24q02m/hull/token-auth'
import { resolveDataDir } from './data-dir.js'

/** A namespace is one path segment: letters, digits, `_` and `-`, at most 64 chars. */
export const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Directory under the data dir that holds one sub-directory per namespace. */
export const USERS_DIR_NAME = 'users'

/** A namespace that cannot be used as a directory name. */
export class NamespaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NamespaceError'
  }
}

/** Return `namespace` when it is a safe single path segment, else throw. */
export function assertNamespace(namespace: string): string {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new NamespaceError(
      `Invalid namespace "${namespace}": use 1-64 letters, digits, "_" or "-", starting with a letter or digit`
    )
  }
  return namespace
}

/**
 * Namespace of the current HTTP multi-user caller, or `null` when the request
 * is not in multi mode (stdio, no-auth, shared token, CLI without `--user`).
 */
export function callerNamespace(): string | null {
  const user = currentUser()
  if (user.mode !== 'multi') return null
  return assertNamespace(user.namespace)
}

/** Directory holding one namespace's files: `<data dir>/users/<namespace>`. */
export function namespaceDir(namespace: string): string {
  return join(resolveDataDir(), USERS_DIR_NAME, assertNamespace(namespace))
}

/** Directory holding the current caller's own files. */
export function callerDataDir(): string {
  const namespace = callerNamespace()
  return namespace === null ? resolveDataDir() : namespaceDir(namespace)
}

/**
 * Run `fn` as the multi-user caller `namespace` (used by the CLI `--user` flag
 * so an operator can sign a user's Outlook account in without an HTTP request).
 */
export function runAsNamespace<T>(namespace: string, fn: () => T): T {
  assertNamespace(namespace)
  return runWithAuthContext({ ...localAuthContext(), uid: namespace, namespace, mode: 'multi' }, fn)
}

/**
 * Key for a process-wide cache entry that belongs to the current caller.
 * Account ids are only unique inside one namespace, so two callers that both
 * name an account `work` must not share cached state.
 */
export function scopedKey(key: string): string {
  const namespace = callerNamespace()
  return namespace === null ? key : `${namespace}\u0000${key}`
}

/**
 * Delete the current caller's entries from a cache keyed with `scopedKey`, and
 * return how many were removed. Outside multi mode the whole cache is cleared.
 */
export function clearScoped(cache: Map<string, unknown>): number {
  const namespace = callerNamespace()
  if (namespace === null) {
    const count = cache.size
    cache.clear()
    return count
  }
  const prefix = `${namespace}\u0000`
  let count = 0
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
      count += 1
    }
  }
  return count
}
