/**
 * Per-account isolation at the tool boundary.
 *
 * One mailbox that cannot be reached (here: a wrong password rejected at login)
 * must not cost the caller the mail the other mailboxes did return, and the
 * failure has to name the account it belongs to. Actions that must act on
 * exactly one account must reject an ambiguous account instead of guessing.
 *
 * imapflow is the only thing mocked: the tools, the dispatch table and the
 * per-account fan-out all run for real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from './helpers/config.js'

interface FakeImapOptions {
  host: string
  port: number
  secure: boolean
  auth: { user: string; pass?: string; accessToken?: string }
  logger: boolean
}

const { buildClient, connectedUsers } = vi.hoisted(() => {
  const connectedUsers: string[] = []

  const buildClient = (options: FakeImapOptions) => {
    const release = vi.fn()
    const folders = [{ name: 'INBOX', path: 'INBOX', flags: new Set(['\\Inbox']), delimiter: '/' }]
    const client = {
      connect: async () => {
        connectedUsers.push(options.auth.user)
        if (options.auth.pass === 'wrong-password') {
          // imapflow's own generic failure text, as the client receives it from the server.
          throw Object.assign(new Error('mailbox server refused the session'), {
            authenticationFailed: true,
            responseText: 'Invalid credentials (Failure)'
          })
        }
      },
      logout: async () => undefined,
      getMailboxLock: async () => ({ release }),
      capabilities: new Map<string, boolean | number>(),
      enabled: new Set<string>(),
      mailbox: { uidNext: 10 },
      search: async () => [options.auth.user === 'ok@example.test' ? 7 : 9],
      fetchAll: async () => [
        {
          uid: options.auth.user === 'ok@example.test' ? 7 : 9,
          flags: new Set<string>(),
          envelope: {
            subject: `Subject for ${options.auth.user}`,
            from: [{ address: options.auth.user }],
            to: [{ address: 'me@example.test' }],
            date: new Date('2026-01-01T00:00:00Z')
          },
          source: Buffer.from('Preview')
        }
      ],
      list: async () => folders
    }
    return client
  }

  return { buildClient, connectedUsers }
})

vi.mock('imapflow', () => ({
  // biome-ignore lint/complexity/useArrowFunction: `new` constructor mock must be a function
  ImapFlow: vi.fn(function (options: FakeImapOptions) {
    return buildClient(options)
  })
}))

vi.mock('mailparser', () => ({
  simpleParser: vi.fn(async () => ({ text: 'Preview' }))
}))

import { invokeTool } from './registry.js'

const accountsFileAccounts: AccountConfig[] = [
  {
    id: 'ok',
    email: 'ok@example.test',
    password: 'right-password',
    imap: { host: 'imap.example.test', port: 993, secure: true },
    smtp: { host: 'smtp.example.test', port: 465, secure: true }
  },
  {
    id: 'broken',
    email: 'broken@example.test',
    password: 'wrong-password',
    imap: { host: 'imap.example.test', port: 993, secure: true },
    smtp: { host: 'smtp.example.test', port: 465, secure: true }
  }
]

beforeEach(() => {
  connectedUsers.length = 0
})

describe('read tools across accounts', () => {
  it('returns the healthy account messages and names the failing account', async () => {
    const result = (await invokeTool('messages', accountsFileAccounts, {
      action: 'search',
      query: 'ALL'
    })) as {
      messages: Array<{ account_email: string; uid: number }>
      accounts_searched: string[]
      unavailable_accounts: Array<{ account_id: string; account_email: string; code: string; reason: string }>
    }

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({ account_email: 'ok@example.test', uid: 7 })
    expect(result.accounts_searched).toEqual(['ok@example.test', 'broken@example.test'])
    expect(result.unavailable_accounts).toEqual([
      {
        account_id: 'broken',
        account_email: 'broken@example.test',
        code: 'IMAP_SEARCH_FAILED',
        reason: 'Unable to search this account: mailbox server refused the session'
      }
    ])
  })

  it('keeps the healthy folder list when the other account cannot log in', async () => {
    const result = (await invokeTool('folders', accountsFileAccounts, { action: 'list' })) as {
      total_accounts: number
      accounts: Array<{ account_id: string; account_email: string; folders: Array<{ path: string }>; error?: string }>
    }

    expect(result.total_accounts).toBe(2)
    expect(result.accounts[0]).toMatchObject({
      account_id: 'ok',
      account_email: 'ok@example.test',
      folders: [{ path: 'INBOX' }]
    })
    expect(result.accounts[1]!.account_id).toBe('broken')
    expect(result.accounts[1]!.account_email).toBe('broken@example.test')
    expect(result.accounts[1]!.error).toContain('IMAP authentication failed')
    expect(result.accounts[1]!.error).toContain('Invalid credentials (Failure)')
    expect(result.accounts[1]!.folders).toEqual([])
  })

  it('does not contact an account whose row is disabled', async () => {
    const withDisabled: AccountConfig[] = [
      ...accountsFileAccounts,
      { ...accountsFileAccounts[0]!, id: 'off', email: 'off@example.test', enabled: false }
    ]

    const result = (await invokeTool('messages', withDisabled, { action: 'search', query: 'ALL' })) as {
      accounts_searched: string[]
    }

    expect(result.accounts_searched).toEqual(['ok@example.test', 'broken@example.test'])
    expect(connectedUsers).not.toContain('off@example.test')
  })
})

describe('single-account actions in multi mode', () => {
  it('rejects a send that does not say which account to send from', async () => {
    await expect(
      invokeTool('messages', accountsFileAccounts, {
        action: 'new',
        to: 'someone@example.test',
        subject: 'Hi',
        body: 'Body'
      })
    ).rejects.toThrow(/Account is required: 2 accounts are configured/)

    try {
      await invokeTool('messages', accountsFileAccounts, {
        action: 'new',
        to: 'someone@example.test',
        subject: 'Hi',
        body: 'Body'
      })
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('ok@example.test')
      expect(message).toContain('broken@example.test')
      return
    }
    throw new Error('expected the send to be rejected as ambiguous')
  })

  it('rejects a read that does not say which account to read from and names the choices', async () => {
    try {
      await invokeTool('messages', accountsFileAccounts, { action: 'read', uid: 1 })
    } catch (error) {
      const err = error as Error & { suggestion?: string }
      expect(err.message).toContain('Account is required')
      expect(err.message).toContain('ok@example.test')
      expect(err.message).toContain('broken@example.test')
      return
    }
    throw new Error('expected the read to be rejected as ambiguous')
  })
})
