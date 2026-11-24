import { join } from 'node:path'
import { decryptSecret, encryptSecret, loadOrCreateKey } from '@n24q02m/hull/storage'
import { resolveDataDir } from '../../data-dir.js'

export const TOKEN_ENVELOPE_VERSION = 1
export const TOKEN_ENVELOPE_ALG = 'aes-256-gcm'
export const SEALED_SECRET_PREFIX = 'enc:'
export const ACCOUNTS_ENC_FILE_NAME = 'accounts.enc'

export interface EncryptedTokenFileEnvelope {
  v: 1
  alg: 'aes-256-gcm'
  envelope: string
}

/**
 * Resolves the path to the 32-byte AES-256-GCM key file inside the data directory.
 */
export function tokenKeyPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return join(resolveDataDir(env, home), '.secret')
}

/**
 * Type guard for an encrypted file envelope written by sealTokenStore or sealAccountsContent.
 */
export function isEncryptedTokenEnvelope(value: unknown): value is EncryptedTokenFileEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const obj = value as Record<string, unknown>
  return (
    obj.v === TOKEN_ENVELOPE_VERSION &&
    obj.alg === TOKEN_ENVELOPE_ALG &&
    typeof obj.envelope === 'string' &&
    obj.envelope.length > 0
  )
}

/**
 * Returns true if a secret string is prefixed as an encrypted hull envelope.
 */
export function isSealedSecretValue(value: string): boolean {
  return value.startsWith(SEALED_SECRET_PREFIX)
}

/**
 * Encrypts a single credential string with the plugin AES-256-GCM key and adds the `enc:` prefix.
 */
export function sealSecretValue(plaintext: string, keyPath: string = tokenKeyPath()): string {
  const key = loadOrCreateKey(keyPath)
  return `${SEALED_SECRET_PREFIX}${encryptSecret(key, plaintext)}`
}

/**
 * Decrypts a credential string prefixed with `enc:`, or returns plaintext values unchanged.
 */
export function unsealSecretValue(value: string, keyPath: string = tokenKeyPath()): string {
  if (!isSealedSecretValue(value)) {
    return value
  }
  const key = loadOrCreateKey(keyPath)
  return decryptSecret(key, value.slice(SEALED_SECRET_PREFIX.length))
}

/**
 * Serializes and encrypts a token store object into an AES-256-GCM JSON envelope.
 */
export function sealTokenStore(store: Record<string, unknown>, keyPath: string = tokenKeyPath()): string {
  const key = loadOrCreateKey(keyPath)
  const envelope = encryptSecret(key, JSON.stringify(store))
  const payload: EncryptedTokenFileEnvelope = {
    v: TOKEN_ENVELOPE_VERSION,
    alg: TOKEN_ENVELOPE_ALG,
    envelope
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * Decrypts an encrypted token store envelope.
 * Returns null if `raw` is not an encrypted envelope (e.g. legacy plaintext JSON).
 * Throws if `raw` is an encrypted envelope whose decryption or JSON payload fails.
 */
export function unsealTokenEnvelope(raw: string, keyPath: string = tokenKeyPath()): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isEncryptedTokenEnvelope(parsed)) {
    return null
  }
  const key = loadOrCreateKey(keyPath)
  const plaintext = decryptSecret(key, parsed.envelope)
  const decoded: unknown = JSON.parse(plaintext)
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Decrypted token store payload is not a JSON object')
  }
  return decoded as Record<string, unknown>
}

/**
 * Encrypts raw TOML accounts file content into an AES-256-GCM JSON envelope.
 */
export function sealAccountsContent(tomlText: string, keyPath: string = tokenKeyPath()): string {
  const key = loadOrCreateKey(keyPath)
  const envelope = encryptSecret(key, tomlText)
  const payload: EncryptedTokenFileEnvelope = {
    v: TOKEN_ENVELOPE_VERSION,
    alg: TOKEN_ENVELOPE_ALG,
    envelope
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * Decrypts raw content if it is an encrypted accounts envelope; returns plaintext TOML otherwise.
 */
export function unsealAccountsContent(raw: string, keyPath: string = tokenKeyPath()): string {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return raw
    }
    if (isEncryptedTokenEnvelope(parsed)) {
      const key = loadOrCreateKey(keyPath)
      return decryptSecret(key, parsed.envelope)
    }
  }
  return raw
}
