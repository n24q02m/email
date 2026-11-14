/**
 * Send Mega Tool
 * Send new emails, reply, and forward via SMTP
 */

import type { AccountConfig } from '../helpers/config.js'
import { isDraftOnly } from '../helpers/draft-only.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { appendToFolder, readEmail, resolveDraftsFolder, resolveSentFolder } from '../helpers/imap-client.js'
import { replySender, resolveSender } from '../helpers/sender.js'
import type { EmailAttachment, SendResult } from '../helpers/smtp-client.js'
import { forwardEmail, forwardSubject, replySubject, replyToEmail, sendNewEmail } from '../helpers/smtp-client.js'

/**
 * Providers whose SMTP servers auto-save sent messages to the Sent folder.
 * IMAP APPEND on these would create duplicates.
 * - Gmail: smtp.gmail.com
 * - Yahoo: smtp.mail.yahoo.com
 * iCloud (smtp.mail.me.com) does not, so it gets an APPEND like any other provider.
 */
function autoSavesToSent(account: AccountConfig): boolean {
  const host = account.smtp.host
  return host.includes('gmail') || host.includes('yahoo')
}

/**
 * Best-effort save to Sent folder via IMAP APPEND.
 * Skips providers that auto-save (Gmail, Yahoo).
 * Failures are silent — sending already succeeded.
 */
async function saveToSent(account: AccountConfig, result: SendResult): Promise<boolean> {
  if (!result.raw || autoSavesToSent(account)) return false
  try {
    const sentFolder = await resolveSentFolder(account)
    return await appendToFolder(account, sentFolder, result.raw, ['\\Seen'])
  } catch {
    return false
  }
}

/** Save instead of send: asked for with `draft: true`, or forced by draft-only mode. */
function asDraft(input: SendInput): boolean {
  return input.draft === true || isDraftOnly()
}

/**
 * After composing: a draft was not sent, so file it in Drafts (failing loudly if that fails);
 * a sent message gets its best-effort copy in Sent.
 */
async function finish(account: AccountConfig, result: SendResult, draft: boolean): Promise<Record<string, unknown>> {
  if (!draft) return { saved_to_sent: await saveToSent(account, result) }
  if (!result.raw) throw new EmailMCPError('could not compose the draft', 'DRAFT_FAILED')
  const drafts_folder = await resolveDraftsFolder(account)
  const saved = await appendToFolder(account, drafts_folder, result.raw, ['\\Draft', '\\Seen'])
  if (!saved) {
    throw new EmailMCPError(`could not save the draft to ${drafts_folder}`, 'DRAFT_FAILED', 'Nothing was sent.')
  }
  return { sent: false, saved_to_drafts: true, drafts_folder }
}

export interface SendInput {
  action: 'new' | 'reply' | 'forward'

  // Sender: optional while exactly one account is configured; required with
  // several, where omitting it is an ACCOUNT_REQUIRED rejection naming them all.
  account?: string

  // From address: the account's own address or one of its aliases, optionally
  // as "Name <address>". Alone it also picks the account that owns the address.
  // Defaults to the account address; a reply defaults to the alias it was sent to.
  from?: string

  // Required for all
  body: string

  // Required for new/forward; optional for reply (auto-derived from original sender)
  to?: string

  // Required for new; optional for reply/forward (auto-derived from original subject)
  subject?: string

  // Optional
  cc?: string
  bcc?: string

  // Reply/Forward - reference to original email
  uid?: number
  folder?: string

  // Optional file attachments, symmetric with the attachments download shape
  attachments?: EmailAttachment[]

  // Save to the Drafts folder instead of sending (always on in draft-only mode)
  draft?: boolean
}

/**
 * Unified send tool - handles all outbound email operations
 */
export async function send(accounts: AccountConfig[], input: SendInput): Promise<any> {
  return withErrorHandling(async () => {
    // The sender must be unambiguous, not always spelled out: a single-account
    // setup sends from that account, and a multi-account setup is rejected with
    // every account named (resolveSender) instead of guessing.
    if (!input.body) {
      throw new EmailMCPError('body is required', 'VALIDATION_ERROR', 'Provide the email body text')
    }

    switch (input.action) {
      case 'new':
        return await handleNew(accounts, input)

      case 'reply':
        return await handleReply(accounts, input)

      case 'forward':
        return await handleForward(accounts, input)

      default:
        throw createUnknownActionError(input.action, 'new, reply, forward')
    }
  })()
}

/**
 * Send a new email
 */
async function handleNew(accounts: AccountConfig[], input: SendInput): Promise<any> {
  if (!input.to) {
    throw new EmailMCPError('to is required for new email', 'VALIDATION_ERROR', 'Provide the recipient email address')
  }

  if (!input.subject) {
    throw new EmailMCPError('subject is required for new email', 'VALIDATION_ERROR', 'Provide the email subject')
  }

  const { account, sender } = resolveSender(accounts, input.account, input.from)

  const result = await sendNewEmail(
    account,
    {
      from: sender.header,
      to: input.to,
      subject: input.subject,
      body: input.body,
      cc: input.cc,
      bcc: input.bcc,
      attachments: input.attachments
    },
    !asDraft(input)
  )

  return {
    action: 'new',
    from: sender.address,
    to: input.to,
    subject: input.subject,
    success: result.success,
    message_id: result.message_id,
    ...(await finish(account, result, asDraft(input)))
  }
}

/**
 * Reply to an email (maintains thread headers)
 * `to` is optional — defaults to the original sender's address
 */
async function handleReply(accounts: AccountConfig[], input: SendInput): Promise<any> {
  if (!input.uid) {
    throw new EmailMCPError(
      'uid is required for reply action',
      'VALIDATION_ERROR',
      'Provide the UID of the email to reply to (from search/read)'
    )
  }

  const resolved = resolveSender(accounts, input.account, input.from)
  const account = resolved.account
  const folder = input.folder || 'INBOX'

  // Read original email to get threading headers + auto-derive `to`
  const original = await readEmail(account, input.uid, folder)

  // Without an explicit `from`, answer from the alias the original was sent to
  const sender = input.from?.trim() ? resolved.sender : replySender(account, original)

  // Auto-derive `to` from original sender if not provided
  const replyTo = input.to || original.from

  if (!replyTo) {
    throw new EmailMCPError(
      'Could not determine reply-to address',
      'VALIDATION_ERROR',
      'Provide the `to` field explicitly, or ensure the original email has a From address'
    )
  }

  const result = await replyToEmail(
    account,
    {
      from: sender.header,
      to: replyTo,
      subject: input.subject || original.subject,
      body: input.body,
      cc: input.cc,
      bcc: input.bcc,
      in_reply_to: original.message_id,
      references: original.references || original.message_id,
      attachments: input.attachments
    },
    !asDraft(input)
  )

  return {
    action: 'reply',
    from: sender.address,
    to: replyTo,
    subject: replySubject(input.subject || original.subject),
    in_reply_to: original.message_id,
    success: result.success,
    message_id: result.message_id,
    ...(await finish(account, result, asDraft(input)))
  }
}

/**
 * Forward an email
 */
async function handleForward(accounts: AccountConfig[], input: SendInput): Promise<any> {
  if (!input.uid) {
    throw new EmailMCPError(
      'uid is required for forward action',
      'VALIDATION_ERROR',
      'Provide the UID of the email to forward (from search/read)'
    )
  }

  if (!input.to) {
    throw new EmailMCPError(
      'to is required for forward action',
      'VALIDATION_ERROR',
      'Provide the recipient email address'
    )
  }

  const { account, sender } = resolveSender(accounts, input.account, input.from)
  const folder = input.folder || 'INBOX'

  // Read original email to include in forward
  const original = await readEmail(account, input.uid, folder)

  const result = await forwardEmail(
    account,
    {
      from: sender.header,
      to: input.to,
      subject: input.subject || original.subject,
      body: input.body,
      cc: input.cc,
      bcc: input.bcc,
      original_body: original.body_text,
      attachments: input.attachments
    },
    !asDraft(input)
  )

  return {
    action: 'forward',
    from: sender.address,
    to: input.to,
    subject: forwardSubject(input.subject || original.subject),
    success: result.success,
    message_id: result.message_id,
    ...(await finish(account, result, asDraft(input)))
  }
}
