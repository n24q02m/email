/**
 * Sender resolution
 * Picks the account and From address for an outbound message. A mailbox can send
 * as its own address or as one of its accounts-file `aliases`; the SMTP login
 * always stays the account's own address.
 */

import type { AccountConfig } from './config.js'
import { enabledAccounts, resolveSingleAccount } from './config.js'
import { EmailMCPError } from './errors.js'

/** A validated From value: the bare address and the header text to send. */
export interface Sender {
  address: string
  header: string
}

const ADDRESS_PATTERN = /^[^\s@<>,]+@[^\s@<>,]+$/
const NAMED_PATTERN = /^(.*?)\s*<([^<>]+)>$/
const ADDRESS_IN_TEXT = /[^\s@<>,"';:()]+@[^\s@<>,"';:()]+/g

/** Every address an account may send as, its own address first. */
export function senderAddresses(account: AccountConfig): string[] {
  return [account.email, ...(account.aliases ?? [])]
}

/** Whether `address` is one the account may send as (case-insensitive). */
function ownsAddress(account: AccountConfig, address: string): boolean {
  const lower = address.toLowerCase()
  return senderAddresses(account).some((candidate) => candidate.toLowerCase() === lower)
}

/**
 * Parse a `from` value: `addr@example.com` or `Display Name <addr@example.com>`.
 * The header is rebuilt by the mail composer, so a display name is quoted there.
 */
export function parseFrom(from: string): Sender {
  const trimmed = from.trim()
  const named = NAMED_PATTERN.exec(trimmed)
  const address = (named ? named[2]! : trimmed).trim()
  if (!ADDRESS_PATTERN.test(address)) {
    throw new EmailMCPError(
      `from "${from}" is not an email address`,
      'VALIDATION_ERROR',
      'Use an address such as team@example.com, or "Name <team@example.com>"'
    )
  }
  const name = named?.[1]?.trim().replace(/^"(.*)"$/, '$1')
  return { address, header: name ? `"${name.replace(/["\\]/g, '')}" <${address}>` : address }
}

/** The account's own address as the sender. */
function defaultSender(account: AccountConfig): Sender {
  return { address: account.email, header: account.email }
}

function notAllowed(sender: Sender, account: AccountConfig): EmailMCPError {
  return new EmailMCPError(
    `${account.email} cannot send as ${sender.address}`,
    'SENDER_NOT_ALLOWED',
    `Use one of: ${senderAddresses(account).join(', ')}. Add other addresses to the account's aliases in accounts.toml`
  )
}

/**
 * Resolve the sending account and From address.
 *
 * - `from` with `account`: the address must belong to that account.
 * - `from` alone: the enabled account that owns the address sends it, so an
 *   alias is enough to pick the mailbox in multi-account mode.
 * - neither: the usual single-account resolution, sending as the account itself.
 */
export function resolveSender(
  accounts: AccountConfig[],
  accountFilter?: string,
  from?: string
): { account: AccountConfig; sender: Sender } {
  if (!from?.trim()) {
    const account = resolveSingleAccount(accounts, accountFilter)
    return { account, sender: defaultSender(account) }
  }

  const sender = parseFrom(from)

  if (accountFilter?.trim()) {
    const account = resolveSingleAccount(accounts, accountFilter)
    if (!ownsAddress(account, sender.address)) throw notAllowed(sender, account)
    return { account, sender }
  }

  const owners = enabledAccounts(accounts).filter((account) => ownsAddress(account, sender.address))
  if (owners.length === 1) return { account: owners[0]!, sender }

  // No owner: with one account, name its allowed addresses; otherwise list them all.
  const usable = enabledAccounts(accounts)
  if (owners.length === 0 && usable.length === 1) throw notAllowed(sender, usable[0]!)
  if (owners.length === 0) {
    throw new EmailMCPError(
      `No configured account can send as ${sender.address}`,
      'SENDER_NOT_ALLOWED',
      `Sender addresses: ${usable.flatMap(senderAddresses).join(', ')}`
    )
  }
  throw new EmailMCPError(
    `Several accounts can send as ${sender.address}`,
    'AMBIGUOUS_ACCOUNT',
    `Pass account: ${owners.map((a) => a.email).join(', ')}`
  )
}

/**
 * The address a reply should come from when `from` is not given: the account
 * alias the original was addressed to (To first, then Cc), or the account itself.
 */
export function replySender(account: AccountConfig, original: { to?: string; cc?: string }): Sender {
  if (!account.aliases?.length) return defaultSender(account)
  const recipients = `${original.to ?? ''},${original.cc ?? ''}`.match(ADDRESS_IN_TEXT) ?? []
  for (const recipient of recipients) {
    if (recipient.toLowerCase() === account.email.toLowerCase()) return defaultSender(account)
    const alias = account.aliases.find((candidate) => candidate.toLowerCase() === recipient.toLowerCase())
    if (alias) return { address: alias, header: alias }
  }
  return defaultSender(account)
}
