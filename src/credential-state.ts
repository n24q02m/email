/**
 * Non-blocking credential state management for email.
 *
 * Credentials come from env vars, the legacy encrypted config (read-only), or
 * saved Outlook OAuth tokens. There is no relay credential form: credentials are
 * supplied through env vars or the `email auth` CLI.
 */

import { deleteConfig, resolveConfig } from '@n24q02m/hull/storage'
import { loadOutlookEmails } from './tools/helpers/oauth2.js'

// Config namespace for hull's encrypted config.enc: resolveConfig/deleteConfig key
// servers[name] with it. Deliberately NOT renamed with the server identity
// (SERVER_NAME = 'email' in init-server.ts): changing it would orphan every saved
// config instead of moving it.
const CONFIG_NAMESPACE = 'better-email-mcp'
const REQUIRED_FIELDS = ['EMAIL_CREDENTIALS']

export type CredentialState = 'awaiting_setup' | 'configured'

let state: CredentialState = 'awaiting_setup'

export function getState(): CredentialState {
  return state
}

/**
 * Format a legacy stored config into the EMAIL_CREDENTIALS string.
 *
 * Supports two stored shapes:
 * - New (multi-account): { EMAIL_CREDENTIALS: "email1:pass1,email2:pass2" }
 * - Legacy (single account): { email, password, imap_host? }
 */
export function legacyCredentials(config: Record<string, string>): string {
  if (config.EMAIL_CREDENTIALS) {
    return config.EMAIL_CREDENTIALS
  }
  const { email, password, imap_host } = config
  if (!email || !password) {
    throw new Error('Stored config missing required fields: EMAIL_CREDENTIALS or email+password')
  }
  if (imap_host) {
    return `${email}:${password}:${imap_host}`
  }
  return `${email}:${password}`
}

/**
 * Fast credential check. Called during server startup.
 *
 * Resolution order:
 * 1. ENV VARS -- EMAIL_CREDENTIALS, or EMAIL_USER + EMAIL_APP_PASSWORD
 * 2. LEGACY CONFIG FILE -- encrypted config.enc from a previous install
 * 3. SAVED OAUTH TOKENS -- Outlook tokens saved by `email auth outlook`
 * 4. NOTHING -- state = awaiting_setup
 *
 * Returns new state. Takes <10ms (no network I/O).
 */
export async function resolveCredentialState(): Promise<CredentialState> {
  if (process.env.EMAIL_CREDENTIALS) {
    state = 'configured'
    return state
  }

  if (process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD) {
    process.env.EMAIL_CREDENTIALS = `${process.env.EMAIL_USER}:${process.env.EMAIL_APP_PASSWORD}`
    state = 'configured'
    return state
  }

  try {
    const result = await resolveConfig(CONFIG_NAMESPACE, REQUIRED_FIELDS)
    if (result.config !== null) {
      process.env.EMAIL_CREDENTIALS = legacyCredentials(result.config)
      console.error(`Email config loaded from ${result.source}`)
      state = 'configured'
      return state
    }
  } catch {
    // Config read failed, continue
  }

  try {
    const emails = await loadOutlookEmails()
    if (emails.length > 0) {
      process.env.EMAIL_CREDENTIALS = emails.map((email) => `${email}:oauth2`).join(',')
      console.error(`Found saved OAuth2 tokens for: ${emails.join(', ')}`)
      state = 'configured'
      return state
    }
  } catch {
    // Token read failed or store error, continue
  }

  console.error('No credentials found -- server starting in awaiting_setup mode')
  state = 'awaiting_setup'
  return state
}

/** For testing and credential lifecycle actions. */
export function setState(newState: CredentialState): void {
  state = newState
}

/** Reset to awaiting_setup (used by the config reset action). */
export async function resetState(): Promise<void> {
  state = 'awaiting_setup'
  try {
    await deleteConfig(CONFIG_NAMESPACE)
  } catch {
    // Ignore
  }
}
