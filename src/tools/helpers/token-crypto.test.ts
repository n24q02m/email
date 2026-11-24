import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDataDir } from '../../data-dir.js'
import { runAsNamespace } from '../../tenant.js'
import { _resetTokenCache, deleteStoredTokens, loadOutlookEmails, loadStoredTokens, saveTokens } from './oauth2.js'
import {
  isEncryptedTokenEnvelope,
  isSealedSecretValue,
  sealAccountsContent,
  sealSecretValue,
  sealTokenStore,
  tokenKeyPath,
  unsealAccountsContent,
  unsealSecretValue,
  unsealTokenEnvelope
} from './token-crypto.js'

describe('token-crypto real AES-256-GCM integration', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'email-token-crypto-'))
    vi.stubEnv('EMAIL_DATA_DIR', dataDir)
    _resetTokenCache()
  })

  afterEach(async () => {
    _resetTokenCache()
    vi.unstubAllEnvs()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('encrypts and decrypts token stores, secrets, and accounts envelopes', () => {
    const keyPath = tokenKeyPath()
    expect(keyPath).toBe(join(resolveDataDir(), '.secret'))

    const store = {
      'a@outlook.com': { accessToken: 'at-secret', refreshToken: 'rt-secret', expiresAt: 1, clientId: 'cid' }
    }
    const sealed = sealTokenStore(store, keyPath)
    expect(sealed).not.toContain('rt-secret')
    expect(sealed).not.toContain('a@outlook.com')
    expect(isEncryptedTokenEnvelope(JSON.parse(sealed))).toBe(true)
    expect(unsealTokenEnvelope(sealed, keyPath)).toEqual(store)

    const sealedPw = sealSecretValue('app-password-xyz', keyPath)
    expect(isSealedSecretValue(sealedPw)).toBe(true)
    expect(sealedPw).not.toContain('app-password-xyz')
    expect(unsealSecretValue(sealedPw, keyPath)).toBe('app-password-xyz')
    expect(unsealSecretValue('plain-pw', keyPath)).toBe('plain-pw')

    const toml = '[accounts.work]\nemail = "a@gmail.com"\npassword = "secret"\n'
    const sealedAccounts = sealAccountsContent(toml, keyPath)
    expect(sealedAccounts).not.toContain('secret')
    expect(unsealAccountsContent(sealedAccounts, keyPath)).toBe(toml)
    expect(unsealAccountsContent(toml, keyPath)).toBe(toml)
  })

  it('rejects corrupt envelopes and non-object payloads', () => {
    const keyPath = tokenKeyPath()
    expect(unsealTokenEnvelope('not-json', keyPath)).toBeNull()
    expect(unsealTokenEnvelope(JSON.stringify({ plain: true }), keyPath)).toBeNull()
    expect(isEncryptedTokenEnvelope(null)).toBe(false)
    expect(isEncryptedTokenEnvelope([])).toBe(false)
    expect(() =>
      unsealTokenEnvelope(JSON.stringify({ v: 1, alg: 'aes-256-gcm', envelope: 'v1:bad:tampered' }), keyPath)
    ).toThrow()

    expect(unsealAccountsContent('{broken-json', keyPath)).toBe('{broken-json')
    expect(() =>
      unsealAccountsContent(JSON.stringify({ v: 1, alg: 'aes-256-gcm', envelope: 'v1:bad:tampered' }), keyPath)
    ).toThrow()
  })

  it('persists encrypted tokens.json on disk via oauth2 helpers and reads them back', async () => {
    const tokens = { accessToken: 'at-real', refreshToken: 'rt-real-secret', expiresAt: 9999999999, clientId: 'cid' }
    await saveTokens('User@Outlook.com', tokens)

    const diskPath = join(resolveDataDir(), 'tokens.json')
    const rawOnDisk = await readFile(diskPath, 'utf8')
    expect(rawOnDisk).not.toContain('rt-real-secret')
    expect(rawOnDisk).not.toContain('user@outlook.com')
    expect(existsSync(join(resolveDataDir(), '.secret'))).toBe(true)

    _resetTokenCache()
    expect(await loadStoredTokens('user@outlook.com')).toEqual(tokens)
    expect(await loadOutlookEmails()).toEqual(['user@outlook.com'])

    const deleted = await deleteStoredTokens('user@outlook.com')
    expect(deleted).toEqual(['user@outlook.com'])
    expect(isEncryptedTokenEnvelope(JSON.parse(await readFile(diskPath, 'utf8')))).toBe(true)
  })

  it('auto-upgrades non-empty legacy plaintext tokens.json on read and handles corrupt envelopes', async () => {
    const diskPath = join(resolveDataDir(), 'tokens.json')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(resolveDataDir(), { recursive: true })
    const legacyTokens = {
      accessToken: 'at-leg',
      refreshToken: 'rt-leg-secret',
      expiresAt: 9999999999,
      clientId: 'cid'
    }
    await writeFile(diskPath, JSON.stringify({ 'legacy@outlook.com': legacyTokens }, null, 2), 'utf8')

    const loaded = await loadStoredTokens('legacy@outlook.com')
    expect(loaded).toEqual(legacyTokens)

    const upgraded = await readFile(diskPath, 'utf8')
    expect(upgraded).not.toContain('rt-leg-secret')
    expect(isEncryptedTokenEnvelope(JSON.parse(upgraded))).toBe(true)

    _resetTokenCache()
    await writeFile(diskPath, JSON.stringify({ v: 1, alg: 'aes-256-gcm', envelope: 'v1:corrupt:tag' }), 'utf8')
    expect(await loadStoredTokens('legacy@outlook.com')).toBeNull()
    expect(await loadOutlookEmails()).toEqual([])
  })

  it('isolates encrypted tokens per HTTP multi-user namespace', async () => {
    const tAlice = { accessToken: 'at-a', refreshToken: 'rt-alice', expiresAt: 1, clientId: 'c' }
    const tBob = { accessToken: 'at-b', refreshToken: 'rt-bob', expiresAt: 2, clientId: 'c' }

    await runAsNamespace('alice', () => saveTokens('alice@outlook.com', tAlice))
    await runAsNamespace('bob', () => saveTokens('bob@outlook.com', tBob))

    _resetTokenCache()
    const aliceRaw = await readFile(join(resolveDataDir(), 'users', 'alice', 'tokens.json'), 'utf8')
    expect(aliceRaw).not.toContain('rt-alice')
    expect(await runAsNamespace('alice', () => loadOutlookEmails())).toEqual(['alice@outlook.com'])
    expect(await runAsNamespace('bob', () => loadOutlookEmails())).toEqual(['bob@outlook.com'])
  })
})
