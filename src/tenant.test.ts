import { join } from 'node:path'
import { currentUser, runWithAuthContext } from '@n24q02m/hull/token-auth'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATA_DIR_ENV, resolveDataDir } from './data-dir.js'
import {
  assertNamespace,
  callerDataDir,
  callerNamespace,
  clearScoped,
  NamespaceError,
  namespaceDir,
  runAsNamespace,
  scopedKey,
  USERS_DIR_NAME
} from './tenant.js'

let savedDataDir: string | undefined

beforeEach(() => {
  savedDataDir = process.env[DATA_DIR_ENV]
  process.env[DATA_DIR_ENV] = join('/', 'srv', 'email-data')
})

afterEach(() => {
  if (savedDataDir === undefined) delete process.env[DATA_DIR_ENV]
  else process.env[DATA_DIR_ENV] = savedDataDir
})

describe('assertNamespace', () => {
  it.each(['alice', 'Bob_2', 'team-a', '0', 'a'.repeat(64)])('accepts %s', (ns) => {
    expect(assertNamespace(ns)).toBe(ns)
  })

  it.each(['', '..', '../etc', 'a/b', 'a\\b', '-lead', '_lead', 'a b', 'a'.repeat(65), 'a\u0000b'])(
    'refuses %j',
    (ns) => {
      expect(() => assertNamespace(ns)).toThrow(NamespaceError)
    }
  )
})

describe('caller namespace', () => {
  it('is null outside multi mode (stdio, CLI, shared token)', () => {
    expect(currentUser().mode).toBe('no-auth')
    expect(callerNamespace()).toBeNull()
    expect(callerDataDir()).toBe(resolveDataDir())
    const tokenUser = { uid: 'token', namespace: 'default', mode: 'token' as const }
    expect(runWithAuthContext(tokenUser as never, () => callerNamespace())).toBeNull()
  })

  it('is the user namespace in multi mode, with its own data directory', () => {
    runAsNamespace('alice', () => {
      expect(callerNamespace()).toBe('alice')
      expect(callerDataDir()).toBe(join(resolveDataDir(), USERS_DIR_NAME, 'alice'))
      expect(callerDataDir()).toBe(namespaceDir('alice'))
    })
  })

  it('refuses a multi-mode namespace that would leave the users directory', () => {
    const user = { uid: 'x', namespace: '../../etc', mode: 'multi' as const }
    expect(() => runWithAuthContext(user as never, () => callerNamespace())).toThrow(NamespaceError)
    expect(() => namespaceDir('..')).toThrow(NamespaceError)
    expect(() => runAsNamespace('../x', () => 1)).toThrow(NamespaceError)
  })

  it('runAsNamespace returns the callback result', async () => {
    expect(runAsNamespace('bob', () => 42)).toBe(42)
    await expect(runAsNamespace('bob', async () => callerNamespace())).resolves.toBe('bob')
  })
})

describe('scoped caches', () => {
  it('keys are unchanged outside multi mode and prefixed per namespace inside it', () => {
    expect(scopedKey('work')).toBe('work')
    const alice = runAsNamespace('alice', () => scopedKey('work'))
    const bob = runAsNamespace('bob', () => scopedKey('work'))
    expect(alice).not.toBe(bob)
    expect(alice).not.toBe('work')
  })

  it('clearScoped removes only the caller entries in multi mode', () => {
    const cache = new Map<string, unknown>()
    cache.set(
      runAsNamespace('alice', () => scopedKey('work')),
      1
    )
    cache.set(
      runAsNamespace('alice', () => scopedKey('home')),
      2
    )
    cache.set(
      runAsNamespace('bob', () => scopedKey('work')),
      3
    )
    // `alice2` shares a textual prefix with `alice`; it must survive alice's clear.
    cache.set(
      runAsNamespace('alice2', () => scopedKey('work')),
      4
    )

    expect(runAsNamespace('alice', () => clearScoped(cache))).toBe(2)
    expect([...cache.values()].sort()).toEqual([3, 4])
    expect(runAsNamespace('carol', () => clearScoped(cache))).toBe(0)
    expect(cache.size).toBe(2)
  })

  it('clearScoped empties the whole cache outside multi mode', () => {
    const cache = new Map<string, unknown>([
      ['a', 1],
      [runAsNamespace('bob', () => scopedKey('b')), 2]
    ])
    expect(clearScoped(cache)).toBe(2)
    expect(cache.size).toBe(0)
  })
})
