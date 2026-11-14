/**
 * `registerTools(..., { resolveAccounts })`: the HTTP multi-user path, where the
 * accounts a tool may use are resolved on every call for the request's caller
 * instead of being captured once when the session's server is built.
 */

import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAsNamespace } from '../tenant.js'
import type { AccountConfig } from './helpers/config.js'
import { NOT_CONFIGURED_MESSAGE } from './helpers/errors.js'
import { registerTools } from './registry.js'

vi.mock('./composite/attachments.js', () => ({ attachments: vi.fn() }))
vi.mock('./composite/folders.js', () => ({ folders: vi.fn() }))
vi.mock('./composite/messages.js', () => ({ messages: vi.fn(), clearArchiveFolderCache: vi.fn() }))
vi.mock('./composite/config.js', () => ({ handleConfig: vi.fn() }))
vi.mock('../credential-state.js', () => ({ getState: vi.fn(() => 'configured') }))
vi.mock('./helpers/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers/config.js')>()),
  loadConfig: vi.fn()
}))

import { getState } from '../credential-state.js'
import { handleConfig } from './composite/config.js'
import { folders } from './composite/folders.js'
import { loadConfig } from './helpers/config.js'

const account = (email: string): AccountConfig => ({
  id: email.replace(/\W/g, '_'),
  email,
  password: 'pw',
  imap: { host: 'imap.example.com', port: 993, secure: true },
  smtp: { host: 'smtp.example.com', port: 465, secure: true }
})

function callToolHandlerFor(startup: AccountConfig[], resolveAccounts: () => Promise<AccountConfig[]>) {
  let handler: any
  registerTools(
    {
      setRequestHandler: vi.fn((schema, fn) => {
        if (schema === CallToolRequestSchema) handler = fn
      })
    } as any,
    startup,
    { resolveAccounts }
  )
  return (name: string, args: Record<string, unknown>) => handler({ params: { name, arguments: args } })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(folders).mockResolvedValue({ ok: true } as any)
  vi.mocked(handleConfig).mockResolvedValue({ action: 'setup_reset' } as any)
})

describe('registerTools with resolveAccounts', () => {
  it('passes the accounts resolved for this call, not the startup snapshot', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce([account('a@example.com')])
      .mockResolvedValueOnce([account('b@x.io')])
    const call = callToolHandlerFor([account('startup@example.com')], resolve)

    await call('folders', { action: 'list' })
    await call('folders', { action: 'list' })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(vi.mocked(folders).mock.calls.map(([accts]) => accts.map((a) => a.email))).toEqual([
      ['a@example.com'],
      ['b@x.io']
    ])
    expect(getState).not.toHaveBeenCalled()
    expect(loadConfig).not.toHaveBeenCalled()
  })

  it('answers a multi-user caller with no accounts with its namespace hint', async () => {
    const call = callToolHandlerFor([], vi.fn().mockResolvedValue([]))

    const result = await runAsNamespace('alice', () => call('folders', { action: 'list' }))

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('user namespace "alice"')
    expect(result.content[0].text).toContain('users/alice/accounts.toml')
    expect(result.content[0].text).toContain('--user alice')
    expect(folders).not.toHaveBeenCalled()
  })

  it('falls back to the generic message when the resolver runs outside multi mode', async () => {
    const call = callToolHandlerFor([], vi.fn().mockResolvedValue([]))

    const result = await call('folders', { action: 'list' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(NOT_CONFIGURED_MESSAGE)
  })

  it('still lets config and help run with no accounts', async () => {
    const call = callToolHandlerFor([], vi.fn().mockResolvedValue([]))

    const result = await runAsNamespace('alice', () => call('config', { action: 'status' }))

    expect(result.isError).toBeUndefined()
    expect(handleConfig).toHaveBeenCalledWith([], { action: 'status' })
  })

  it('does not clear the startup snapshot after a setup_reset', async () => {
    const startup = [account('startup@example.com')]
    const call = callToolHandlerFor(startup, vi.fn().mockResolvedValue(startup))

    await call('config', { action: 'setup_reset' })

    expect(startup).toHaveLength(1)
  })
})
