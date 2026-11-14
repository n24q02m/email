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
  clearSentFolderCache: vi.fn().mockReturnValue(1),
  clearDraftsFolderCache: vi.fn().mockReturnValue(0)
}))

vi.mock('../helpers/oauth2.js', () => ({
  _resetTokenCache: vi.fn()
}))

vi.mock('../helpers/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../helpers/config.js')>()),
  loadConfig: vi.fn()
}))

import { getState, resetState, resolveCredentialState } from '../../credential-state.js'
import { runAsNamespace } from '../../tenant.js'
import { loadConfig } from '../helpers/config.js'
import { clearSentFolderCache } from '../helpers/imap-client.js'
import { _resetTokenCache } from '../helpers/oauth2.js'
import { handleConfig } from './config.js'
import { clearArchiveFolderCache } from './messages.js'

const mockGetState = vi.mocked(getState)
const mockResetState = vi.mocked(resetState)
const mockResolveCredentialState = vi.mocked(resolveCredentialState)
const mockLoadConfig = vi.mocked(loadConfig)

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
      mode: 'multi',
      accounts: ['user1@gmail.com', 'user2@outlook.com']
    })
  })

  it('lists sender aliases per enabled account', async () => {
    mockGetState.mockReturnValue('configured')
    const withAliases: AccountConfig[] = [
      { ...accounts[0]!, aliases: ['team@example.com'] },
      accounts[1]!,
      { ...accounts[1]!, id: 'off', email: 'off@example.com', enabled: false, aliases: ['x@example.com'] }
    ]

    const result = await handleConfig(withAliases, { action: 'status' })

    expect(result).toMatchObject({ aliases: { 'user1@gmail.com': ['team@example.com'] } })
  })

  it('returns empty accounts when none configured', async () => {
    mockGetState.mockReturnValue('awaiting_setup')

    const result = await handleConfig([], { action: 'status' })

    expect(result).toEqual({
      action: 'status',
      state: 'awaiting_setup',
      mode: 'none',
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
        'Set EMAIL_ACCOUNTS_FILE to an accounts.toml (multi-account), or EMAIL_CREDENTIALS / EMAIL_USER + EMAIL_APP_PASSWORD, and restart the server; or run `email auth outlook <address>` from the CLI.'
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
    mockLoadConfig.mockResolvedValue([...accounts])

    const result = await handleConfig([...accounts], { action: 'setup_complete' })

    expect(mockResolveCredentialState).toHaveBeenCalledOnce()
    expect(result).toEqual({
      action: 'setup_complete',
      previous_state: 'awaiting_setup',
      state: 'configured',
      mode: 'multi',
      accounts: ['user1@gmail.com', 'user2@outlook.com']
    })
  })

  it('reloads the accounts emptied by setup_reset and refills the shared snapshot', async () => {
    mockGetState.mockReturnValue('awaiting_setup')
    mockResolveCredentialState.mockResolvedValue('configured')
    mockLoadConfig.mockResolvedValue([...accounts])
    const snapshot: AccountConfig[] = []

    const result = await handleConfig(snapshot, { action: 'setup_complete' })

    expect(mockLoadConfig).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      state: 'configured',
      mode: 'multi',
      accounts: ['user1@gmail.com', 'user2@outlook.com']
    })
    expect(snapshot.map((a) => a.email)).toEqual(['user1@gmail.com', 'user2@outlook.com'])
  })

  it('empties the snapshot without reading accounts when still not configured', async () => {
    mockGetState.mockReturnValue('configured')
    mockResolveCredentialState.mockResolvedValue('awaiting_setup')
    const snapshot: AccountConfig[] = [...accounts]

    await handleConfig(snapshot, { action: 'setup_complete' })

    expect(mockLoadConfig).not.toHaveBeenCalled()
    expect(snapshot).toEqual([])
  })

  it('returns empty accounts when still not configured', async () => {
    mockGetState.mockReturnValue('awaiting_setup')
    mockResolveCredentialState.mockResolvedValue('awaiting_setup')

    const result = await handleConfig([], { action: 'setup_complete' })

    expect(result).toEqual({
      action: 'setup_complete',
      previous_state: 'awaiting_setup',
      state: 'awaiting_setup',
      mode: 'none',
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

describe('config - HTTP multi-user caller', () => {
  const asAlice = <T>(fn: () => Promise<T>) => runAsNamespace('alice', fn)

  it('status reports only the accounts resolved for the caller, never the server-wide state', async () => {
    mockGetState.mockReturnValue('awaiting_setup')
    const result = await asAlice(() => handleConfig([accounts[0]!], { action: 'status' }))
    expect(result).toEqual({ action: 'status', state: 'configured', mode: 'single', accounts: ['user1@gmail.com'] })
  })

  it('setup_status and setup_start reflect the caller namespace', async () => {
    expect(await asAlice(() => handleConfig([], { action: 'setup_status' }))).toEqual({
      action: 'setup_status',
      state: 'awaiting_setup'
    })
    const start = (await asAlice(() => handleConfig(accounts, { action: 'setup_start' }))) as {
      state: string
      message: string
    }
    expect(start.state).toBe('configured')
    expect(start.message).toContain('users/alice/accounts.toml')
    expect(start.message).toContain('--user alice')
  })

  it.each(['setup_reset', 'setup_complete'] as const)(
    'refuses %s and leaves the server state alone',
    async (action) => {
      await expect(asAlice(() => handleConfig(accounts, { action }))).rejects.toMatchObject({
        code: 'MULTI_USER_HOST_SIDE'
      })
      expect(mockResetState).not.toHaveBeenCalled()
      expect(mockResolveCredentialState).not.toHaveBeenCalled()
    }
  )

  it('set and cache_clear behave as in single-user mode', async () => {
    expect(await asAlice(() => handleConfig(accounts, { action: 'set' }))).toMatchObject({ action: 'set', ok: false })
    expect(await asAlice(() => handleConfig(accounts, { action: 'cache_clear' }))).toMatchObject({
      action: 'cache_clear',
      ok: true
    })
  })

  it('rejects an unknown action', async () => {
    const input = { action: 'unknown' } as unknown as ConfigInput
    await expect(asAlice(() => handleConfig(accounts, input))).rejects.toThrow('Unknown action: unknown')
  })
})
