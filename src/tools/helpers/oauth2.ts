/**
 * OAuth2 for Outlook.com / Hotmail / Live accounts
 *
 * Microsoft has disabled Basic Auth for Outlook/Hotmail/Live accounts (September 2024).
 * This module implements Device Code Grant (RFC 8628) for CLI-based auth,
 * persistent token storage, and automatic token refresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tryOpenBrowser } from '@n24q02m/hull'
import { setState } from '../../credential-state.js'
import { isSafeUrl } from './security.js'

// Microsoft OAuth2 endpoints. The tenant segment decides which directory signs
// the user in: "consumers" = personal Microsoft accounts, "common" = personal
// plus work/school (Entra ID), or a specific tenant GUID / verified domain.
// It is configurable because a work/school mailbox can neither complete the
// device-code flow nor refresh a token minted elsewhere against /consumers —
// the refresh fails with AADSTS7000012 (grant obtained for a different tenant).
const DEFAULT_TENANT = 'consumers'

// The tenant is interpolated into the endpoint path, so keep it to the shapes
// Microsoft actually accepts (GUID, "common"/"consumers"/"organizations", or a
// verified domain). Anything carrying a separator is refused rather than
// reshaping the URL.
const TENANT_PATTERN = /^[A-Za-z0-9._-]+$/

let warnedInvalidTenant: string | null = null

/**
 * Tenant used for the device-code and token endpoints. ``OUTLOOK_TENANT`` wins
 * when it is set and well-formed; otherwise the caller's default applies.
 */
export function getOutlookTenant(fallback: string = DEFAULT_TENANT): string {
  const configured = process.env.OUTLOOK_TENANT?.trim()
  if (!configured) return fallback
  if (!TENANT_PATTERN.test(configured)) {
    if (warnedInvalidTenant !== configured) {
      warnedInvalidTenant = configured
      console.error(`[email] Ignoring malformed OUTLOOK_TENANT; falling back to "${fallback}".`)
    }
    return fallback
  }
  return configured
}

function authBase(): string {
  return `https://login.microsoftonline.com/${getOutlookTenant()}/oauth2/v2.0`
}

function deviceCodeUrl(): string {
  return `${authBase()}/devicecode`
}

function tokenUrl(): string {
  return `${authBase()}/token`
}

// IMAP + SMTP + offline_access (for refresh tokens)
// Full resource URL with outlook.office.com — required for personal Microsoft accounts.
// outlook.office.com (personal/MSA) vs outlook.office365.com (work/school/Entra ID).
// Short scopes (no URL) produce Microsoft Graph tokens that Exchange Online IMAP rejects.
const DEFAULT_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access'
]

/**
 * Scopes requested at sign-in and re-sent on refresh. ``OUTLOOK_SCOPES``
 * (space-separated) overrides the default set — a grant consented with a
 * narrower scope (IMAP-only, no SMTP) is legitimate for read-only deployments,
 * and refreshing such a grant against the full list is rejected.
 */
export function getOutlookScopes(fallback: string[] = DEFAULT_SCOPES): string[] {
  const configured = process.env.OUTLOOK_SCOPES?.trim()
  if (!configured) return [...fallback]
  return configured.split(/\s+/).filter(Boolean)
}

// Time constants
const MS_PER_SECOND = 1000
const DEFAULT_POLLING_INTERVAL_SECONDS = 5
const SLOW_DOWN_BACKOFF_MS = 5000
const TOKEN_REFRESH_BUFFER_SECONDS = 300

// Persistent token storage: ~/.better-email-mcp/tokens.json (0600). The directory
// keeps its pre-rename name so tokens saved by earlier releases stay readable.
const CONFIG_DIR = join(homedir(), '.better-email-mcp')
const TOKEN_FILE = join(CONFIG_DIR, 'tokens.json')

export interface OAuth2Tokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp (seconds)
  clientId: string
}

export interface EnsureValidTokenOptions {
  allowInteractive?: boolean
}

export type OAuth2AuthErrorCode = 'OAUTH_AUTH_REQUIRED' | 'OAUTH_REFRESH_FAILED'

export class OAuth2AuthError extends Error {
  constructor(
    public readonly code: OAuth2AuthErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OAuth2AuthError'
  }
}

interface TokenStore {
  [email: string]: OAuth2Tokens
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
  message: string
  error?: string
  error_description?: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  error?: string
  error_description?: string
}

/**
 * Type guard to validate OAuth2Tokens structure
 */
export function isValidTokens(data: unknown): data is OAuth2Tokens {
  if (!data || typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return (
    typeof d.accessToken === 'string' &&
    d.accessToken.length > 0 &&
    typeof d.refreshToken === 'string' &&
    d.refreshToken.length > 0 &&
    typeof d.expiresAt === 'number' &&
    !Number.isNaN(d.expiresAt) &&
    d.expiresAt > 0 &&
    typeof d.clientId === 'string' &&
    d.clientId.length > 0
  )
}

/**
 * Type guard to validate TokenStore structure
 */
export function isValidTokenStore(data: unknown): data is TokenStore {
  if (!data || typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const d = data as Record<string, unknown>
  return Object.values(d).every(isValidTokens)
}

/**
 * Safely parse a JSON string into a TokenStore, hardening against prototype pollution.
 * Returns null if the JSON is malformed or validation fails.
 */
function parseTokenStore(jsonString: string): TokenStore | null {
  try {
    const parsed = JSON.parse(jsonString)
    if (!isValidTokenStore(parsed)) {
      return null
    }

    // Transfer to a null-prototype object
    const safe = Object.create(null)
    Object.assign(safe, parsed)

    // Explicitly delete prototype-polluting keys just in case
    // biome-ignore lint/suspicious/noProto: Hardening against prototype pollution by removing the raw __proto__ key if passed in JSON.
    delete safe.__proto__
    delete safe.constructor
    delete safe.prototype

    return safe as TokenStore
  } catch {
    return null
  }
}

/** Outlook/Hotmail/Live domains that require OAuth2 */
/**
 * Extract the "sub" claim from an OIDC id_token without verifying signatures.
 * id_token is a JWT (header.payload.signature).
 */
export function decodeIdTokenSubject(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

const OUTLOOK_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com'])

/**
 * Additional domains routed to OAuth via ``OUTLOOK_EXTRA_DOMAINS``
 * (comma-separated). An M365 mailbox on a custom domain looks like any other
 * address, so without this it is treated as a password account — and Microsoft
 * disabled basic auth for Exchange Online in 2024, leaving no working path.
 */
function extraOutlookDomains(): string[] {
  const configured = process.env.OUTLOOK_EXTRA_DOMAINS?.trim()
  if (!configured) return []
  return configured
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Check if an email address belongs to an Outlook/Hotmail/Live domain, or to a
 * domain the deployment declared as OAuth-backed via ``OUTLOOK_EXTRA_DOMAINS``.
 */
export function isOutlookDomain(email: string): boolean {
  const atIndex = email.indexOf('@')
  if (atIndex === -1) return false
  const domain = email.substring(atIndex + 1).toLowerCase()
  return OUTLOOK_DOMAINS.has(domain) || extraOutlookDomains().includes(domain)
}

// Bundled Azure AD public client ID for email.
// Public clients have no secret — this is safe to embed (like Thunderbird's client ID).
// Override with OUTLOOK_CLIENT_ID env var if you want to use your own Azure AD app.
const DEFAULT_CLIENT_ID = 'd56f8c71-9f7c-43f4-9934-be29cb6e77b0'

/**
 * Get the Azure AD client ID for OAuth2.
 * Uses bundled client ID by default, can be overridden via OUTLOOK_CLIENT_ID env var.
 */
export function getClientId(): string {
  return process.env.OUTLOOK_CLIENT_ID || DEFAULT_CLIENT_ID
}

/**
 * In-memory cache of the email-keyed token file (single-user).
 */
let cachedTokenStore: TokenStore | null = null

/** Exposed for testing */
export function _resetTokenCache(): void {
  cachedTokenStore = null
}

/**
 * Load stored OAuth2 tokens for an email account. Returns null if none stored.
 */
export async function loadStoredTokens(email: string): Promise<OAuth2Tokens | null> {
  if (!email?.trim()) throw new Error('Email is required')
  const key = email.toLowerCase()
  try {
    if (cachedTokenStore) {
      return cachedTokenStore[key] || null
    }
    const data = await readFile(TOKEN_FILE, 'utf-8')
    const store = parseTokenStore(data)
    if (!store) {
      return null
    }
    cachedTokenStore = store
    return store[key] || null
  } catch {
    return null
  }
}

/**
 * Emails (keys) of the stored Outlook token file. Used at startup by
 * credential-state to synthesize the ``email:oauth2`` credential string.
 */
export async function loadOutlookEmails(): Promise<string[]> {
  try {
    const data = await readFile(TOKEN_FILE, 'utf-8')
    const store = parseTokenStore(data)
    return store ? Object.keys(store).filter((k) => k.includes('@')) : []
  } catch {
    return []
  }
}

/**
 * Persist OAuth2 tokens to the email-keyed ``tokens.json`` (0600).
 */
export async function saveTokens(email: string, tokens: OAuth2Tokens): Promise<void> {
  if (!email?.trim()) throw new Error('Email is required')
  saveTokensToFile(email.toLowerCase(), tokens)
}

/**
 * Delete stored OAuth2 token(s) from the token file. Omitting ``email`` clears
 * every stored token. Returns the email keys that were actually removed (empty
 * array if there was nothing to delete).
 */
export async function deleteStoredTokens(email?: string): Promise<string[]> {
  if (!existsSync(TOKEN_FILE)) {
    cachedTokenStore = null
    return []
  }

  let store: TokenStore
  try {
    const data = readFileSync(TOKEN_FILE, 'utf-8')
    store = parseTokenStore(data) ?? {}
  } catch {
    store = {}
  }

  const deleted: string[] = []
  if (email) {
    const key = email.toLowerCase()
    if (store[key]) {
      delete store[key]
      deleted.push(key)
    }
  } else {
    deleted.push(...Object.keys(store))
    store = {}
  }

  if (deleted.length === 0) {
    return deleted
  }

  cachedTokenStore = store
  writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
  return deleted
}

/**
 * Write the email-keyed ``tokens.json`` (0600). Synchronous; creates the config dir if needed.
 */
function saveTokensToFile(emailKey: string, tokens: OAuth2Tokens): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  }

  let store: TokenStore = cachedTokenStore || {}
  try {
    if (!cachedTokenStore && existsSync(TOKEN_FILE)) {
      const data = readFileSync(TOKEN_FILE, 'utf-8')
      const parsedStore = parseTokenStore(data)
      if (parsedStore) {
        store = parsedStore
      } else {
        store = {}
      }
    }
  } catch {
    // Start fresh if file is corrupted
    store = {}
  }

  store[emailKey] = tokens
  cachedTokenStore = store
  writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
}

/**
 * Refresh an access token using the stored refresh token.
 * Microsoft may rotate the refresh token on each use.
 */
export async function refreshAccessToken(clientId: string, refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: getOutlookScopes().join(' ')
    })
  })

  const data = (await response.json()) as TokenResponse

  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`)
  }

  return data
}

/**
 * Track pending Device Code auth flows so we don't request new codes on every retry.
 * Maps email → { verificationUri, userCode, expiresAt }
 */
interface PendingAuth {
  verificationUri: string
  userCode: string
  expiresAt: number
}
const pendingAuths = new Map<string, PendingAuth>()

/** Exposed for testing */
export function _getPendingAuths(): Map<string, PendingAuth> {
  return pendingAuths
}

/**
 * Open a URL in the user's default browser safely. Wraps ``tryOpenBrowser``
 * from ``@n24q02m/hull`` in a fire-and-forget fashion so OAuth callers do not
 * block on browser launch. Validates URL before opening to prevent injection.
 */
function openBrowser(url: string): void {
  if (isSafeUrl(url)) {
    void tryOpenBrowser(url)
  } else {
    console.error(`[SECURITY] Refused to open unsafe URL: ${url}`)
  }
}

/**
 * Request a device code from Microsoft's OAuth2 endpoint.
 */
async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const response = await fetch(deviceCodeUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      scope: getOutlookScopes().join(' ')
    })
  })

  const data = (await response.json()) as DeviceCodeResponse

  if (data.error || !data.user_code) {
    throw new Error(`Device code request failed: ${data.error_description || data.error || 'Unknown error'}`)
  }

  return data
}

/**
 * Poll for token in the background. Saves to the token file when authorized.
 * Runs silently — errors are logged to stderr, not thrown.
 */
function startBackgroundPoll(
  clientId: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  email: string
): void {
  const emailKey = email.toLowerCase()
  const deadline = Date.now() + expiresIn * MS_PER_SECOND
  let pollInterval = (interval || DEFAULT_POLLING_INTERVAL_SECONDS) * MS_PER_SECOND

  const poll = async () => {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))

      const response = await fetch(tokenUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode
        })
      })

      const data = (await response.json()) as TokenResponse

      if (data.access_token) {
        const now = Math.floor(Date.now() / MS_PER_SECOND)
        await saveTokens(email, {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: now + data.expires_in,
          clientId
        })
        pendingAuths.delete(emailKey)
        setState('configured')
        return
      }
      if (data.error === 'authorization_pending') continue
      if (data.error === 'slow_down') {
        pollInterval += SLOW_DOWN_BACKOFF_MS
        continue
      }

      // authorization_declined, expired_token, etc.
      pendingAuths.delete(emailKey)
      return
    }

    pendingAuths.delete(emailKey)
  }

  poll().catch(() => pendingAuths.delete(emailKey))
}

/**
 * Initiate the Device Code OAuth flow for an Outlook account without throwing.
 * Returns the sign-in URL and user code; the background poll saves tokens on success.
 *
 * If a pending auth already exists for this email, returns the existing codes
 * instead of requesting new ones.
 */
export async function initiateOutlookDeviceCode(
  email: string
): Promise<{ verificationUri: string; userCode: string; expiresIn: number; interval: number }> {
  if (!email?.trim()) throw new Error('Email is required')
  const emailKey = email.toLowerCase()
  const existing = pendingAuths.get(emailKey)
  if (existing && existing.expiresAt > Date.now()) {
    return {
      verificationUri: existing.verificationUri,
      userCode: existing.userCode,
      expiresIn: Math.max(1, Math.floor((existing.expiresAt - Date.now()) / MS_PER_SECOND)),
      interval: DEFAULT_POLLING_INTERVAL_SECONDS
    }
  }

  const clientId = getClientId()
  const codeData = await requestDeviceCode(clientId)

  pendingAuths.set(emailKey, {
    verificationUri: codeData.verification_uri,
    userCode: codeData.user_code,
    expiresAt: Date.now() + codeData.expires_in * MS_PER_SECOND
  })

  startBackgroundPoll(clientId, codeData.device_code, codeData.interval, codeData.expires_in, email)

  // Auto-open browser for desktop environments (best-effort; no-op in CI/E2E)
  openBrowser(codeData.verification_uri)

  return {
    verificationUri: codeData.verification_uri,
    userCode: codeData.user_code,
    expiresIn: codeData.expires_in,
    interval: codeData.interval || DEFAULT_POLLING_INTERVAL_SECONDS
  }
}

/**
 * Ensure the account has a valid (non-expired) access token.
 *
 * Stored tokens are loaded when ``account.oauth2`` is absent. If no tokens are
 * available, the default is non-interactive: no Device Code request,
 * background poll, or browser launch is started. Instead, the function throws
 * ``OAuth2AuthError`` with the stable ``OAUTH_AUTH_REQUIRED`` code. Pass
 * ``{ allowInteractive: true }`` explicitly to start or resume the Device
 * Code flow; that path may open the verification URL in a browser and throws
 * sign-in instructions while the background poll runs. On a later retry, the
 * function picks up tokens saved by that poll.
 *
 * If tokens exist but are expired or within the five-minute safety buffer, the
 * access token is refreshed automatically. Refreshed tokens are persisted and
 * ``account.oauth2`` is updated in place. A refresh failure throws
 * ``OAuth2AuthError`` with the stable ``OAUTH_REFRESH_FAILED`` code.
 *
 * @param account Account whose OAuth2 token should be validated and updated.
 * @param options Controls whether missing-token authentication may start the
 *   interactive Device Code flow. Interactive authentication is disabled by
 *   default.
 * @throws ``OAuth2AuthError`` with ``OAUTH_AUTH_REQUIRED`` when authentication
 *   is missing in non-interactive mode, or ``OAUTH_REFRESH_FAILED`` when token
 *   refresh fails.
 */
export async function ensureValidToken(
  account: { email: string; oauth2?: OAuth2Tokens },
  options: EnsureValidTokenOptions = {}
): Promise<string> {
  // Try loading from disk (background auth may have saved tokens since last call)
  if (!account.oauth2) {
    const stored = await loadStoredTokens(account.email)
    if (stored) {
      account.oauth2 = stored
    }
  }

  if (!account.oauth2) {
    if (!options.allowInteractive) {
      throw new OAuth2AuthError('OAUTH_AUTH_REQUIRED', 'OAuth authentication required for this account.')
    }

    const emailKey = account.email.toLowerCase()

    const pending = pendingAuths.get(emailKey)

    if (pending && pending.expiresAt > Date.now()) {
      // Auth flow already in progress — show same code
      throw new Error(
        `Outlook sign-in in progress for ${account.email}.\n` +
          `Visit: ${pending.verificationUri}\n` +
          `Enter code: ${pending.userCode}\n\n` +
          `After signing in, retry your request.`
      )
    }

    // Start new Device Code flow
    const clientId = getClientId()
    const codeData = await requestDeviceCode(clientId)

    pendingAuths.set(emailKey, {
      verificationUri: codeData.verification_uri,
      userCode: codeData.user_code,
      expiresAt: Date.now() + codeData.expires_in * MS_PER_SECOND
    })

    startBackgroundPoll(clientId, codeData.device_code, codeData.interval, codeData.expires_in, account.email)

    // Auto-open browser for desktop environments
    openBrowser(codeData.verification_uri)

    throw new Error(
      `Outlook OAuth2 sign-in required for ${account.email}.\n` +
        `Visit: ${codeData.verification_uri}\n` +
        `Enter code: ${codeData.user_code}\n\n` +
        `After signing in, retry your request.`
    )
  }

  const now = Math.floor(Date.now() / MS_PER_SECOND)
  const buffer = TOKEN_REFRESH_BUFFER_SECONDS // 5-minute safety buffer

  if (account.oauth2.expiresAt > now + buffer) {
    return account.oauth2.accessToken
  }

  // Token expired or about to expire — refresh
  let newTokens: TokenResponse
  try {
    newTokens = await refreshAccessToken(account.oauth2.clientId, account.oauth2.refreshToken)
  } catch {
    throw new OAuth2AuthError('OAUTH_REFRESH_FAILED', 'OAuth token refresh failed; explicit authorization is required.')
  }

  account.oauth2.accessToken = newTokens.access_token
  account.oauth2.expiresAt = now + newTokens.expires_in
  // Microsoft may issue a new refresh token — always update if provided
  if (newTokens.refresh_token) {
    account.oauth2.refreshToken = newTokens.refresh_token
  }

  // Persist updated tokens to the token file.
  await saveTokens(account.email, account.oauth2)

  return newTokens.access_token
}

/**
 * Save Outlook tokens from an external OAuth callback.
 *
 * The callback delivers ``OAuthTokens`` (Record<string, unknown>); this adapts
 * them to the ``saveTokens(email, OAuth2Tokens)`` format used by the CLI flow.
 *
 * The email is taken from the token's ``email`` field or from the
 * ``OUTLOOK_EMAIL`` env var. When neither is present, tokens are stored under
 * the ``sub`` or ``id_token`` subject claim as a fallback.
 */
export async function saveOutlookTokens(tokens: Record<string, unknown>): Promise<void> {
  const email =
    (typeof tokens.email === 'string' ? tokens.email : null) ??
    process.env.OUTLOOK_EMAIL ??
    (typeof tokens.sub === 'string' ? tokens.sub : null) ??
    decodeIdTokenSubject(tokens.id_token) ??
    'outlook-device-code'

  const now = Math.floor(Date.now() / MS_PER_SECOND)
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600
  await saveTokens(email, {
    accessToken: typeof tokens.access_token === 'string' ? tokens.access_token : '',
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
    expiresAt: now + expiresIn,
    clientId: typeof tokens.client_id === 'string' ? tokens.client_id : getClientId()
  })

  setState('configured')
}

/**
 * Interactive Device Code flow for CLI-based OAuth2 authentication.
 * Prints instructions to stderr and polls until user authorizes or timeout.
 * Used by `npx @n24q02m/email auth <email>`.
 */
export async function deviceCodeAuth(email: string, clientId?: string): Promise<OAuth2Tokens> {
  if (!email?.trim()) throw new Error('Email is required')
  const resolvedClientId = clientId || getClientId()
  const codeData = await requestDeviceCode(resolvedClientId)

  console.error(`\nTo sign in, visit: ${codeData.verification_uri}`)
  console.error(`Enter code: ${codeData.user_code}\n`)
  console.error('Waiting for authorization...')

  const interval = (codeData.interval || DEFAULT_POLLING_INTERVAL_SECONDS) * MS_PER_SECOND
  const deadline = Date.now() + codeData.expires_in * MS_PER_SECOND
  let pollInterval = interval

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval))

    const tokenResponse = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: resolvedClientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: codeData.device_code
      })
    })

    const tokenData = (await tokenResponse.json()) as TokenResponse

    if (tokenData.access_token) {
      const now = Math.floor(Date.now() / MS_PER_SECOND)
      const tokens: OAuth2Tokens = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: now + tokenData.expires_in,
        clientId: resolvedClientId
      }

      await saveTokens(email, tokens)
      setState('configured')
      console.error(`\nSuccess! Token saved for ${email}`)
      return tokens
    }

    if (tokenData.error === 'authorization_pending') {
      continue
    }

    if (tokenData.error === 'slow_down') {
      pollInterval += SLOW_DOWN_BACKOFF_MS // Back off as requested by server
      continue
    }

    // Other errors (expired_token, authorization_declined, bad_verification_code)
    throw new Error(`Authorization failed: ${tokenData.error_description || tokenData.error}`)
  }

  throw new Error('Authorization timed out. Please try again.')
}
