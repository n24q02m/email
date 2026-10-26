import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'
import type { ConfigInput } from './config.js'

// --- Mocks ---
vi.mock('../../credential-state.js', () => ({
  getState: vi.fn(),
  resetState: vi.fn(),
  resolveCredentialState: vi.fn()
}))

vi.mock('./messages.js', () => ({
  clearArchiveFolderCache: vi.fn().mockReturnValue(2)
}))

vi.mock('../helpers/imap-client.js', () => ({
  clearSentFolderCache: vi.fn().mockReturnValue(1)
}))

vi.mock('../helpers/oauth2.js', () => ({
  _resetTokenCache: vi.fn()
}))

import { getState, resetState, resolveCredentialState } from '../../credential-state.js'
import { clearSentFolderCache } from '../helpers/imap-client.js'
import { _resetTokenCache } from '../helpers/oauth2.js'
import { handleConfig } from './config.js'
import { clearArchiveFolderCache } from './messages.js'

const mockGetState = vi.mocked(getState)
const mockResetState = vi.mocked(resetState)
const mockResolveCredentialState = vi.mocked(resolveCredentialState)

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
  vi.mocked(clearArchiveFolderCache).mockReturnValue(2)
  vi.mocked(clearSentFolderCache).mockReturnValue(1)
})

describe('config - status', () => {
  it('returns current state with configured accounts', async () => {
    mockGetState.mockReturnValue('configured')

    const result = await handleConfig(accounts, { action: 'status' })

    expect(result).toEqual({
      action: 'status',
      state: 'configured',
      accounts: ['user1@gmail.com', 'user2@outlook.com']
    })
  })

  it('returns empty accounts when none configured', async () => {
    mockGetState.mockReturnValue('awaiting_setup')

    const result = await handleConfig([], { action: 'status' })

    expect(result).toEqual({
      action: 'status',
      state: 'awaiting_setup',
      accounts: []
    })
  })
})

describe('config - setup_status', () => {
  it('returns credential state without the accounts list', async () => {
    mockGetState.mockReturnValue('configured')

    const result = await handleConfig(accounts, { action: 'setup_status' })

    expect(result).toEqual({
      action: 'setup_status',
      state: 'configured'
    })
    expect(result).not.toHaveProperty('accounts')
  })
})

describe('config - setup_start', () => {
  it('returns current state and setup instructions without a URL', async () => {
    mockGetState.mockReturnValue('awaiting_setup')

    const result = await handleConfig([], { action: 'setup_start' })

    expect(result).toEqual({
      action: 'setup_start',
      state: 'awaiting_setup',
      message:
        'Set EMAIL_CREDENTIALS (or EMAIL_USER + EMAIL_APP_PASSWORD) and restart the server, or run `email auth outlook <address>` from the CLI.'
    })
    expect(result).not.toHaveProperty('setup_url')
  })
})

describe('config - setup_reset', () => {
  it('resets state and returns confirmation', async () => {
    mockResetState.mockResolvedValue(undefined)
    mockGetState.mockReturnValue('awaiting_setup')

    const result = await handleConfig(accounts, { action: 'setup_reset' })

    expect(mockResetState).toHaveBeenCalledOnce()
    expect(result).toEqual({
      action: 'setup_reset',
      state: 'awaiting_setup',
      message: 'Credential state reset to awaiting_setup. Stored config deleted.'
    })
  })
})

describe('config - setup_complete', () => {
  it('re-checks and returns configured state with accounts', async () => {
    mockGetState.mockReturnValue('awaiting_setup')
    mockResolveCredentialState.mockResolvedValue('configured')

    const result = await handleConfig(accounts, { action: 'setup_complete' })

    expect(mockResolveCredentialState).toHaveBeenCalledOnce()
    expect(result).toEqual({
      action: 'setup_complete',
      previous_state: 'awaiting_setup',
      state: 'configured',
      accounts: ['user1@gmail.com', 'user2@outlook.com']
    })
  })

  it('returns empty accounts when still not configured', async () => {
    mockGetState.mockReturnValue('awaiting_setup')
    mockResolveCredentialState.mockResolvedValue('awaiting_setup')

    const result = await handleConfig([], { action: 'setup_complete' })

    expect(result).toEqual({
      action: 'setup_complete',
      previous_state: 'awaiting_setup',
      state: 'awaiting_setup',
      accounts: []
    })
  })
})

describe('config - set', () => {
  it('returns stub indicating email has no runtime settings', async () => {
    const result = await handleConfig(accounts, { action: 'set' })

    expect(result).toEqual({
      action: 'set',
      ok: false,
      text: 'email has no runtime settings'
    })
  })
})

describe('config - cache_clear', () => {
  it('clears all in-memory caches and returns cleared count', async () => {
    const result = await handleConfig(accounts, { action: 'cache_clear' })

    expect(clearSentFolderCache).toHaveBeenCalledOnce()
    expect(clearArchiveFolderCache).toHaveBeenCalledOnce()
    expect(_resetTokenCache).toHaveBeenCalledOnce()
    expect(result).toEqual({
      action: 'cache_clear',
      ok: true,
      cleared: 3 // 1 (sent) + 2 (archive)
    })
  })
})

describe('config - unknown action', () => {
  it('throws for unknown action', async () => {
    const input = { action: 'unknown' } as unknown as ConfigInput
    await expect(handleConfig(accounts, input)).rejects.toThrow('Unknown action: unknown')
  })
})
