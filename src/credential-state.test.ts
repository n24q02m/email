import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock all external dependencies BEFORE importing the module under test
vi.mock('@n24q02m/hull/storage', () => ({
  resolveConfig: vi.fn(),
  deleteConfig: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./tools/helpers/oauth2.js', () => ({
  loadOutlookEmails: vi.fn().mockResolvedValue([])
}))

import { deleteConfig, resolveConfig } from '@n24q02m/hull/storage'
import { loadOutlookEmails } from './tools/helpers/oauth2.js'

describe('credential-state', () => {
  let mod: typeof import('./credential-state.js')

  beforeEach(async () => {
    vi.resetModules()
    // Reset env
    delete process.env.EMAIL_CREDENTIALS
    delete process.env.EMAIL_USER
    delete process.env.EMAIL_APP_PASSWORD
    delete process.env.EMAIL_PROVIDER
    // Re-import to get fresh module state
    mod = await import('./credential-state.js')
  })

  afterEach(() => {
    delete process.env.EMAIL_CREDENTIALS
    delete process.env.EMAIL_USER
    delete process.env.EMAIL_APP_PASSWORD
    delete process.env.EMAIL_PROVIDER
    vi.restoreAllMocks()
  })

  describe('getState', () => {
    it('returns awaiting_setup by default', () => {
      expect(mod.getState()).toBe('awaiting_setup')
    })
  })

  describe('setState', () => {
    it('sets state to configured', () => {
      mod.setState('configured')
      expect(mod.getState()).toBe('configured')
    })

    it('sets state back to awaiting_setup', () => {
      mod.setState('configured')
      mod.setState('awaiting_setup')
      expect(mod.getState()).toBe('awaiting_setup')
    })
  })

  describe('legacyCredentials', () => {
    it('returns EMAIL_CREDENTIALS when present', () => {
      expect(mod.legacyCredentials({ EMAIL_CREDENTIALS: 'A:B' })).toBe('A:B')
    })

    it('builds email:password from the legacy single-account shape', () => {
      expect(mod.legacyCredentials({ email: 'e', password: 'p' })).toBe('e:p')
    })

    it('appends imap_host from the legacy single-account shape', () => {
      expect(mod.legacyCredentials({ email: 'e', password: 'p', imap_host: 'h' })).toBe('e:p:h')
    })

    it('throws when the legacy shape lacks email or password', () => {
      expect(() => mod.legacyCredentials({ email: 'e' })).toThrow('missing required fields')
    })
  })

  describe('resolveCredentialState', () => {
    it('returns configured when EMAIL_CREDENTIALS env is set', async () => {
      process.env.EMAIL_CREDENTIALS = 'A:B'
      const result = await mod.resolveCredentialState()
      expect(result).toBe('configured')
      expect(mod.getState()).toBe('configured')
    })

    it('returns configured when EMAIL_USER + EMAIL_APP_PASSWORD env vars are set (stdio per-field)', async () => {
      process.env.EMAIL_USER = 'U'
      process.env.EMAIL_APP_PASSWORD = 'P'
      const result = await mod.resolveCredentialState()
      expect(result).toBe('configured')
      expect(process.env.EMAIL_CREDENTIALS).toBe('U:P')
    })

    it('returns awaiting_setup when only EMAIL_USER is set', async () => {
      process.env.EMAIL_USER = 'U'
      const result = await mod.resolveCredentialState()
      expect(result).toBe('awaiting_setup')
    })

    it('returns awaiting_setup when only EMAIL_APP_PASSWORD is set', async () => {
      process.env.EMAIL_APP_PASSWORD = 'P'
      const result = await mod.resolveCredentialState()
      expect(result).toBe('awaiting_setup')
    })

    it('returns configured when config file has credentials', async () => {
      vi.mocked(resolveConfig).mockResolvedValue({
        config: { EMAIL_CREDENTIALS: 'A:B' },
        source: 'file'
      } as any)

      const result = await mod.resolveCredentialState()
      expect(result).toBe('configured')
      expect(process.env.EMAIL_CREDENTIALS).toBe('A:B')
    })

    it('returns configured when saved OAuth tokens exist', async () => {
      vi.mocked(resolveConfig).mockResolvedValue({ config: null, source: '' } as any)
      vi.mocked(loadOutlookEmails).mockResolvedValue(['E1'])

      const result = await mod.resolveCredentialState()
      expect(result).toBe('configured')
      expect(process.env.EMAIL_CREDENTIALS).toBe('E1:oauth2')
    })

    it('joins multiple saved OAuth token emails into the credential string', async () => {
      vi.mocked(resolveConfig).mockResolvedValue({ config: null, source: '' } as any)
      vi.mocked(loadOutlookEmails).mockResolvedValue(['E1', 'E2'])

      const result = await mod.resolveCredentialState()
      expect(result).toBe('configured')
      expect(process.env.EMAIL_CREDENTIALS).toBe('E1:oauth2,E2:oauth2')
    })

    it('returns awaiting_setup when nothing found (no config, no saved tokens)', async () => {
      vi.mocked(resolveConfig).mockResolvedValue({ config: null, source: '' } as any)
      vi.mocked(loadOutlookEmails).mockResolvedValue([])

      const result = await mod.resolveCredentialState()
      expect(result).toBe('awaiting_setup')
    })

    it('handles config read error gracefully', async () => {
      vi.mocked(resolveConfig).mockRejectedValue(new Error('decrypt fail'))
      vi.mocked(loadOutlookEmails).mockResolvedValue([])

      const result = await mod.resolveCredentialState()
      expect(result).toBe('awaiting_setup')
    })

    it('handles a saved token read error gracefully', async () => {
      vi.mocked(resolveConfig).mockResolvedValue({ config: null, source: '' } as any)
      vi.mocked(loadOutlookEmails).mockRejectedValue(new Error('READ_ERROR'))

      const result = await mod.resolveCredentialState()
      expect(result).toBe('awaiting_setup')
    })
  })

  describe('resetState', () => {
    it('resets to awaiting_setup', async () => {
      mod.setState('configured')

      await mod.resetState()

      expect(mod.getState()).toBe('awaiting_setup')
      expect(vi.mocked(deleteConfig)).toHaveBeenCalledWith('better-email-mcp')
    })

    it('handles deleteConfig error gracefully', async () => {
      vi.mocked(deleteConfig).mockRejectedValue(new Error('file not found'))

      mod.setState('configured')
      await mod.resetState()
      expect(mod.getState()).toBe('awaiting_setup')
    })
  })
})
