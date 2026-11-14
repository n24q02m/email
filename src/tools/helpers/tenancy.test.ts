/**
 * Per-namespace credential storage for HTTP multi-user mode, against the real
 * filesystem: Outlook grants (`tokens.json`) and mailboxes (`accounts.toml`)
 * resolve under `<data dir>/users/<namespace>/` for a multi-user caller and
 * under the data dir itself otherwise.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATA_DIR_ENV, resolveDataDir } from '../../data-dir.js'
import { runAsNamespace } from '../../tenant.js'
import { loadCallerConfig, namespaceAccountsFile } from './config.js'
import {
  _resetTokenCache,
  deleteStoredTokens,
  loadOutlookEmails,
  loadStoredTokens,
  type OAuth2Tokens,
  saveTokens,
  tokenFile
} from './oauth2.js'

const ENV_KEYS = [DATA_DIR_ENV, 'EMAIL_CREDENTIALS', 'EMAIL_ACCOUNTS_FILE', 'EMAIL_USER', 'EMAIL_APP_PASSWORD'] as const
let root: string
let savedEnv: Record<string, string | undefined>

const grant = (accessToken: string): OAuth2Tokens => ({
  accessToken,
  refreshToken: `${accessToken}-refresh`,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  clientId: 'cid'
})

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  root = mkdtempSync(join(tmpdir(), 'email-tenancy-'))
  process.env[DATA_DIR_ENV] = root
  _resetTokenCache()
})

afterEach(() => {
  _resetTokenCache()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(root, { recursive: true, force: true })
})

describe('Outlook token store per namespace', () => {
  it('resolves tokens.json under the caller namespace', () => {
    expect(tokenFile()).toBe(join(resolveDataDir(), 'tokens.json'))
    expect(runAsNamespace('alice', () => tokenFile())).toBe(join(resolveDataDir(), 'users', 'alice', 'tokens.json'))
  })

  it('keeps grants of different namespaces and of the server apart', async () => {
    await runAsNamespace('alice', () => saveTokens('Shared@Outlook.com', grant('alice-at')))
    await runAsNamespace('bob', () => saveTokens('shared@outlook.com', grant('bob-at')))
    await saveTokens('operator@outlook.com', grant('server-at'))

    expect((await runAsNamespace('alice', () => loadStoredTokens('shared@outlook.com')))?.accessToken).toBe('alice-at')
    expect((await runAsNamespace('bob', () => loadStoredTokens('shared@outlook.com')))?.accessToken).toBe('bob-at')
    expect(await runAsNamespace('bob', () => loadStoredTokens('operator@outlook.com'))).toBeNull()
    expect(await loadStoredTokens('shared@outlook.com')).toBeNull()

    expect(await runAsNamespace('alice', () => loadOutlookEmails())).toEqual(['shared@outlook.com'])
    expect(await loadOutlookEmails()).toEqual(['operator@outlook.com'])

    const aliceFile = join(resolveDataDir(), 'users', 'alice', 'tokens.json')
    expect(Object.keys(JSON.parse(readFileSync(aliceFile, 'utf-8')))).toEqual(['shared@outlook.com'])
  })

  it('logout in one namespace leaves the others', async () => {
    await runAsNamespace('alice', () => saveTokens('a@outlook.com', grant('a')))
    await runAsNamespace('bob', () => saveTokens('a@outlook.com', grant('b')))

    expect(await runAsNamespace('alice', () => deleteStoredTokens())).toEqual(['a@outlook.com'])
    expect(await runAsNamespace('alice', () => loadStoredTokens('a@outlook.com'))).toBeNull()
    expect((await runAsNamespace('bob', () => loadStoredTokens('a@outlook.com')))?.accessToken).toBe('b')
    expect(await runAsNamespace('carol', () => deleteStoredTokens())).toEqual([])
  })

  it('a namespace cache reset drops only that caller cached store', async () => {
    await runAsNamespace('alice', () => saveTokens('a@outlook.com', grant('old')))
    await runAsNamespace('bob', () => saveTokens('a@outlook.com', grant('old')))
    // Both stores are now cached. Rewrite both files behind the cache.
    for (const ns of ['alice', 'bob']) {
      const file = join(resolveDataDir(), 'users', ns, 'tokens.json')
      writeFileSync(file, JSON.stringify({ 'a@outlook.com': grant('new') }))
    }

    runAsNamespace('alice', () => _resetTokenCache())

    expect((await runAsNamespace('alice', () => loadStoredTokens('a@outlook.com')))?.accessToken).toBe('new')
    expect((await runAsNamespace('bob', () => loadStoredTokens('a@outlook.com')))?.accessToken).toBe('old')
  })
})

describe('loadCallerConfig', () => {
  const writeAccounts = (ns: string, body: string) => {
    const file = namespaceAccountsFile(ns)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body)
    return file
  }

  it('is loadConfig outside multi mode', async () => {
    process.env.EMAIL_CREDENTIALS = 'operator@example.com:pw:imap.example.com'
    expect((await loadCallerConfig()).map((a) => a.email)).toEqual(['operator@example.com'])
  })

  it('never serves the server-wide accounts to a namespace without its own', async () => {
    process.env.EMAIL_CREDENTIALS = 'operator@example.com:pw:imap.example.com'
    expect(await runAsNamespace('alice', () => loadCallerConfig())).toEqual([])
    expect(existsSync(namespaceAccountsFile('alice'))).toBe(false)
  })

  it('reads the namespace accounts file and adds Outlook grants it does not list', async () => {
    const file = writeAccounts(
      'alice',
      '[accounts.work]\nemail = "alice@example.com"\npassword = "pw"\nimap_host = "imap.example.com"\n' +
        '[accounts.mail]\nemail = "Listed@Outlook.com"\npassword = "pw2"\n'
    )
    expect(file).toBe(join(resolveDataDir(), 'users', 'alice', 'accounts.toml'))
    await runAsNamespace('alice', () => saveTokens('listed@outlook.com', grant('x')))
    await runAsNamespace('alice', () => saveTokens('extra@outlook.com', grant('y')))

    const accounts = await runAsNamespace('alice', () => loadCallerConfig())

    expect(accounts.map((a) => a.email).sort()).toEqual([
      'Listed@Outlook.com',
      'alice@example.com',
      'extra@outlook.com'
    ])
    expect(accounts.find((a) => a.email === 'extra@outlook.com')?.authType).toBe('oauth2')
    expect(await runAsNamespace('bob', () => loadCallerConfig())).toEqual([])
  })

  it('sees an edited accounts file on the next call', async () => {
    writeAccounts('bob', '[accounts.a]\nemail = "one@example.com"\npassword = "pw"\nimap_host = "imap.example.com"\n')
    expect((await runAsNamespace('bob', () => loadCallerConfig())).map((a) => a.email)).toEqual(['one@example.com'])
    writeAccounts('bob', '[accounts.a]\nemail = "two@example.com"\npassword = "pw"\nimap_host = "imap.example.com"\n')
    expect((await runAsNamespace('bob', () => loadCallerConfig())).map((a) => a.email)).toEqual(['two@example.com'])
  })
})
