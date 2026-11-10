import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'

// --- Mocks ---
vi.mock('../helpers/imap-client.js', () => ({
  getFolderStatus: vi.fn(),
  listFolders: vi.fn()
}))

import { getFolderStatus, listFolders } from '../helpers/imap-client.js'
import { folders } from './folders.js'

const mockGetFolderStatus = vi.mocked(getFolderStatus)
const mockListFolders = vi.mocked(listFolders)

const accounts: AccountConfig[] = [
  {
    id: 'user1_gmail_com',
    email: 'user1@gmail.com',
    password: 'pass1',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true }
  },
  {
    id: 'user2_outlook_com',
    email: 'user2@outlook.com',
    password: 'pass2',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false }
  }
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('folders - list', () => {
  it('lists folders for all accounts', async () => {
    mockListFolders.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', flags: [], delimiter: '/' }])

    const result = await folders(accounts, { action: 'list' })

    expect(result.action).toBe('list')
    expect(result.total_accounts).toBe(2)
    expect(result.accounts).toHaveLength(2)
    expect(mockListFolders).toHaveBeenCalledTimes(2)
  })

  it('filters by account', async () => {
    mockListFolders.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', flags: [], delimiter: '/' }])

    const result = await folders(accounts, { action: 'list', account: 'user1@gmail.com' })

    expect(result.total_accounts).toBe(1)
    expect(result.accounts[0].account_email).toBe('user1@gmail.com')
    expect(mockListFolders).toHaveBeenCalledTimes(1)
  })

  it('includes error when one account fails', async () => {
    mockListFolders
      .mockResolvedValueOnce([{ name: 'INBOX', path: 'INBOX', flags: [], delimiter: '/' }])
      .mockRejectedValueOnce(new Error('Auth failed'))

    const result = await folders(accounts, { action: 'list' })

    expect(result.total_accounts).toBe(2)
    expect(result.accounts[0].folders).toHaveLength(1)
    expect(result.accounts[1].error).toBe('Auth failed')
    expect(result.accounts[1].folders).toHaveLength(0)
  })

  it(`surfaces OAuth IMAP rejection instead of collapsing it to ${['Command', 'failed'].join(' ')}`, async () => {
    mockListFolders.mockRejectedValueOnce(
      Object.assign(new Error(['Command', 'failed'].join(' ')), {
        authenticationFailed: true,
        responseText: 'AUTHENTICATIONFAILED'
      })
    )

    const result = await folders([{ ...accounts[1]!, authType: 'oauth2', password: '' }], { action: 'list' })

    expect(result.accounts[0].error).toBe('OAuth/IMAP authentication failed or was rejected (AUTHENTICATIONFAILED)')
  })

  it('names a rejected password login instead of imapflow generic command failure text', async () => {
    mockListFolders
      .mockResolvedValueOnce([{ name: 'INBOX', path: 'INBOX', flags: [], delimiter: '/' }])
      .mockRejectedValueOnce(
        Object.assign(new Error(['Command', 'failed'].join(' ')), {
          authenticationFailed: true,
          responseText: 'Invalid credentials'
        })
      )

    const result = await folders(accounts, { action: 'list' })

    expect(result.accounts[0].folders).toHaveLength(1)
    expect(result.accounts[1].error).toBe(
      'IMAP authentication failed - check the password or app password (Invalid credentials)'
    )
    expect(result.accounts[1].error).not.toContain(['Command', 'failed'].join(' '))
  })

  it('surfaces safe IMAP response fields for a generic OAuth command failure', async () => {
    mockListFolders.mockRejectedValueOnce(
      Object.assign(new Error(['Command', 'failed'].join(' ')), {
        responseStatus: 'NO',
        serverResponseCode: 'AUTHENTICATIONFAILED',
        responseText: 'OAuth bearer token rejected'
      })
    )

    const result = await folders([{ ...accounts[1]!, authType: 'oauth2', password: '' }], { action: 'list' })

    expect(result.accounts[0].error).toContain('OAuth/IMAP authentication failed or was rejected')
    expect(result.accounts[0].error).toContain('AUTHENTICATIONFAILED')
    expect(result.accounts[0].error).not.toContain('Bearer token')
  })

  it('throws when account not found', async () => {
    await expect(folders(accounts, { action: 'list', account: 'nonexistent@test.com' })).rejects.toThrow(
      'Account not found'
    )
  })

  it('throws for unknown action', async () => {
    await expect(folders(accounts, { action: 'unknown' as any })).rejects.toThrow()
  })
})

describe('folders - status', () => {
  it('returns read-only STATUS metadata for one exact account and folder', async () => {
    mockGetFolderStatus.mockResolvedValue({ messages: 10_025, unseen: 17, uid_next: 10_026 })

    const result = await folders(accounts, {
      action: 'status',
      account: 'user1@gmail.com',
      folder: 'INBOX'
    })

    expect(mockGetFolderStatus).toHaveBeenCalledWith(accounts[0], 'INBOX')
    expect(result).toEqual({
      action: 'status',
      account_id: 'user1_gmail_com',
      account_email: 'user1@gmail.com',
      folder: 'INBOX',
      messages: 10_025,
      unseen: 17,
      uid_next: 10_026
    })
  })

  it('uses the only configured account when none is named', async () => {
    mockGetFolderStatus.mockResolvedValue({ messages: 1, unseen: 0, uid_next: 2 })

    const result = await folders([accounts[0]!], { action: 'status', folder: 'INBOX' })

    expect(result.account_email).toBe('user1@gmail.com')
  })

  it('names the accounts instead of guessing when several are configured', async () => {
    await expect(folders(accounts, { action: 'status', folder: 'INBOX' })).rejects.toThrow(
      /Account is required: 2 accounts are configured \(user1@gmail\.com, user2@outlook\.com\)/
    )
  })

  it('requires an explicit folder', async () => {
    await expect(folders(accounts, { action: 'status', account: 'user1@gmail.com' })).rejects.toThrow(
      'folder is required for status action'
    )
  })
})
