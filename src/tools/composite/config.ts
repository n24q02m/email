/**
 * Config Tool
 * Unified credential lifecycle + runtime configuration.
 * Replaces the former `setup` tool with canonical name `config`.
 *
 * Setup actions (credential lifecycle):
 *   status, setup_status, setup_start, setup_reset, setup_complete
 *
 * Runtime config actions:
 *   set, cache_clear
 *
 * Credentials are supplied through env vars (EMAIL_CREDENTIALS, or
 * EMAIL_USER + EMAIL_APP_PASSWORD) or the `email auth` CLI. This tool does not
 * open a browser form.
 *
 * HTTP multi-user mode: the state reported is the caller's own (configured when
 * its namespace has a mailbox), and the server-wide lifecycle actions
 * (`setup_reset`, `setup_complete`) are refused, because a caller must never
 * reset or reload the operator's or another caller's credentials. Accounts are
 * provisioned host-side per namespace.
 */

import type { CredentialState } from '../../credential-state.js'
import { getState, resetState, resolveCredentialState } from '../../credential-state.js'
import { callerNamespace } from '../../tenant.js'
import type { AccountConfig, AccountMode } from '../helpers/config.js'
import { accountMode, enabledAccounts, isAccountEnabled, loadConfig } from '../helpers/config.js'
import { refuseInDraftOnly } from '../helpers/draft-only.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { clearDraftsFolderCache, clearSentFolderCache } from '../helpers/imap-client.js'
import { _resetTokenCache } from '../helpers/oauth2.js'
import { clearArchiveFolderCache } from './messages.js'

export interface ConfigInput {
  action: 'status' | 'setup_status' | 'setup_start' | 'setup_reset' | 'setup_complete' | 'set' | 'cache_clear'
  key?: string
  value?: string
}

interface ConfigStatusResult {
  action: 'status'
  state: CredentialState
  /** `single` with one usable account, `multi` with two or more, `none` with none. */
  mode: AccountMode
  accounts: string[]
  disabled_accounts?: string[]
  /** Sender aliases per enabled account email, when any account has them. */
  aliases?: Record<string, string[]>
}

interface ConfigSetupStatusResult {
  action: 'setup_status'
  state: CredentialState
}

interface ConfigSetupStartResult {
  action: 'setup_start'
  state: CredentialState
  message: string
}

interface ConfigSetupResetResult {
  action: 'setup_reset'
  state: CredentialState
  message: string
}

interface ConfigSetupCompleteResult {
  action: 'setup_complete'
  previous_state: CredentialState
  state: CredentialState
  mode: AccountMode
  accounts: string[]
}

interface ConfigSetResult {
  action: 'set'
  ok: false
  text: string
}

interface ConfigCacheClearResult {
  action: 'cache_clear'
  ok: true
  cleared: number
}

type ConfigResult =
  | ConfigStatusResult
  | ConfigSetupStatusResult
  | ConfigSetupStartResult
  | ConfigSetupResetResult
  | ConfigSetupCompleteResult
  | ConfigSetResult
  | ConfigCacheClearResult

/**
 * Unified config tool - credential lifecycle + runtime settings
 */
export async function handleConfig(accounts: AccountConfig[], input: ConfigInput): Promise<ConfigResult> {
  return withErrorHandling(async () => {
    refuseInDraftOnly('config', input.action)
    const namespace = callerNamespace()
    if (namespace !== null) return handleNamespaceConfig(namespace, accounts, input)
    switch (input.action) {
      case 'status':
        return handleStatus(accounts)

      case 'setup_status':
        return handleSetupStatus()

      case 'setup_start':
        return handleSetupStart()

      case 'setup_reset':
        return await handleSetupReset()

      case 'setup_complete':
        return await handleSetupComplete(accounts)

      case 'set':
        return handleSet()

      case 'cache_clear':
        return handleCacheClear()

      default:
        throw createUnknownActionError(
          input.action,
          'status, setup_status, setup_start, setup_reset, setup_complete, set, cache_clear'
        )
    }
  })()
}

/** `config` for an HTTP multi-user caller: scoped to the caller's namespace. */
function handleNamespaceConfig(namespace: string, accounts: AccountConfig[], input: ConfigInput): ConfigResult {
  const state: CredentialState = accounts.length > 0 ? 'configured' : 'awaiting_setup'
  switch (input.action) {
    case 'status':
      return { ...handleStatus(accounts), state }

    case 'setup_status':
      return { action: 'setup_status', state }

    case 'setup_start':
      return {
        action: 'setup_start',
        state,
        message:
          `Accounts for user namespace "${namespace}" are provisioned by the server operator: ` +
          `users/${namespace}/accounts.toml under the server's email data directory, ` +
          `or \`email auth outlook <address> --user ${namespace}\` for an Outlook address. ` +
          'Changes apply on the next tool call.'
      }

    case 'setup_reset':
    case 'setup_complete':
      throw new EmailMCPError(
        `config ${input.action} is not available to a multi-user caller`,
        'MULTI_USER_HOST_SIDE',
        'Accounts are managed per user namespace by the server operator; use action "status" to see your accounts.'
      )

    case 'set':
      return handleSet()

    case 'cache_clear':
      return handleCacheClear()

    default:
      throw createUnknownActionError(
        input.action,
        'status, setup_status, setup_start, setup_reset, setup_complete, set, cache_clear'
      )
  }
}

function handleStatus(accounts: AccountConfig[]): ConfigStatusResult {
  // Report the accounts a tool call may actually use; a row with
  // `enabled = false` is listed separately so the file and the report agree.
  const disabled = accounts.filter((account) => !isAccountEnabled(account))
  const withAliases = enabledAccounts(accounts).filter((a) => a.aliases?.length)
  return {
    action: 'status',
    state: getState(),
    mode: accountMode(accounts),
    accounts: enabledAccounts(accounts).map((a) => a.email),
    ...(disabled.length > 0 ? { disabled_accounts: disabled.map((a) => a.email) } : {}),
    ...(withAliases.length > 0 ? { aliases: Object.fromEntries(withAliases.map((a) => [a.email, a.aliases!])) } : {})
  }
}

function handleSetupStatus(): ConfigSetupStatusResult {
  return {
    action: 'setup_status',
    state: getState()
  }
}

function handleSetupStart(): ConfigSetupStartResult {
  return {
    action: 'setup_start',
    state: getState(),
    message:
      'Set EMAIL_ACCOUNTS_FILE to an accounts.toml (multi-account), or EMAIL_CREDENTIALS / EMAIL_USER + EMAIL_APP_PASSWORD, and restart the server; or run `email auth outlook <address>` from the CLI.'
  }
}

async function handleSetupReset(): Promise<ConfigSetupResetResult> {
  await resetState()
  return {
    action: 'setup_reset',
    state: getState(),
    message: 'Credential state reset to awaiting_setup. Stored config deleted.'
  }
}

async function handleSetupComplete(accounts: AccountConfig[]): Promise<ConfigSetupCompleteResult> {
  const previousState = getState()
  const newState = await resolveCredentialState()
  // `accounts` is the server's shared snapshot, emptied in place by setup_reset:
  // re-read the source and refill it in place so this reply and the next tool
  // call in every session see the same accounts.
  const reloaded = newState === 'configured' ? await loadConfig() : []
  accounts.splice(0, accounts.length, ...reloaded)
  return {
    action: 'setup_complete',
    previous_state: previousState,
    state: newState,
    mode: newState === 'configured' ? accountMode(accounts) : 'none',
    accounts: newState === 'configured' ? enabledAccounts(accounts).map((a) => a.email) : []
  }
}

function handleSet(): ConfigSetResult {
  return {
    action: 'set',
    ok: false,
    text: 'email has no runtime settings'
  }
}

function handleCacheClear(): ConfigCacheClearResult {
  const sentCount = clearSentFolderCache()
  const archiveCount = clearArchiveFolderCache()
  _resetTokenCache()
  const cleared = sentCount + archiveCount + clearDraftsFolderCache()
  return {
    action: 'cache_clear',
    ok: true,
    cleared
  }
}
