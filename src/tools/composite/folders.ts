/**
 * Folders Mega Tool
 * List mailbox folders across email accounts
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveAccounts, resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { getFolderStatus, listFolders } from '../helpers/imap-client.js'

export interface FoldersInput {
  action: 'list' | 'status'

  // Target account (optional - defaults to all)
  account?: string

  // Exact mailbox path (required for status)
  folder?: string
}

function describeFolderError(account: AccountConfig, error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)

  const raw = error as {
    message?: unknown
    authenticationFailed?: unknown
    responseText?: unknown
    responseStatus?: unknown
    serverResponseCode?: unknown
    oauthError?: unknown
  }
  const oauthError =
    raw.oauthError && typeof raw.oauthError === 'object' ? (raw.oauthError as { error?: unknown }).error : undefined
  const details = [raw.responseStatus, raw.serverResponseCode, raw.responseText, oauthError]
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    .map((value) =>
      String(value)
        .replace(/Bearer\s+\S+/gi, '[redacted token]')
        .slice(0, 160)
    )
  if (account.authType === 'oauth2' && (raw.authenticationFailed === true || details.length > 0)) {
    const response = details.length > 0 ? ` (${details.join('; ')})` : ''
    return `OAuth/IMAP authentication failed or was rejected${response}`
  }

  // A password account whose login was refused: the server's own text ("Invalid
  // credentials") is the actionable part, and imapflow's generic command-failure
  // text is not. Named per account by the caller, so the failure stays
  // attributable when other accounts keep returning folders.
  if (raw.authenticationFailed === true) {
    const response = details.length > 0 ? ` (${details.join('; ')})` : ''
    return `IMAP authentication failed - check the password or app password${response}`
  }

  return typeof raw.message === 'string' ? raw.message : String(error)
}

/**
 * Unified folders tool - handles folder listing
 */
export async function folders(accounts: AccountConfig[], input: FoldersInput): Promise<any> {
  return withErrorHandling(async () => {
    switch (input.action) {
      case 'list':
        return await handleList(accounts, input)

      case 'status':
        return await handleStatus(accounts, input)

      default:
        throw createUnknownActionError(input.action, 'list, status')
    }
  })()
}

/**
 * Read STATUS metadata for one exact account and mailbox.
 */
async function handleStatus(accounts: AccountConfig[], input: FoldersInput): Promise<any> {
  // The account is resolved, not demanded: one configured account is used as-is,
  // and several are rejected with every account named (resolveSingleAccount).
  if (!input.folder?.trim()) {
    throw new EmailMCPError(
      'folder is required for status action',
      'VALIDATION_ERROR',
      'Provide one exact mailbox path, such as INBOX'
    )
  }

  const account = resolveSingleAccount(accounts, input.account)
  const status = await getFolderStatus(account, input.folder)

  return {
    action: 'status',
    account_id: account.id,
    account_email: account.email,
    folder: input.folder,
    ...status
  }
}

/**
 * List folders across accounts
 */
async function handleList(accounts: AccountConfig[], input: FoldersInput): Promise<any> {
  const targetAccounts = resolveAccounts(accounts, input.account)

  const accountPromises = targetAccounts.map(async (account) => {
    try {
      const folderList = await listFolders(account)
      return {
        account_id: account.id,
        account_email: account.email,
        folders: folderList
      }
    } catch (error: unknown) {
      return {
        account_id: account.id,
        account_email: account.email,
        error: describeFolderError(account, error),
        folders: []
      }
    }
  })

  const results = await Promise.all(accountPromises)

  return {
    action: 'list',
    total_accounts: results.length,
    accounts: results
  }
}
