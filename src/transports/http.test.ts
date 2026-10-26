import type * as Hull from '@n24q02m/hull'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_TOKEN_HASH = 'test-token-hash-not-a-secret'
const TEST_ACCOUNTS = [{ id: 'acct-1' }]
const ENV_KEYS = ['HOST', 'PORT', 'MCP_PORT', 'EMAIL_MCP_TOKEN_HASH'] as const

const runHttpServerMock = vi.hoisted(() => vi.fn())
const registerToolsMock = vi.hoisted(() => vi.fn())
const resolveCredentialStateMock = vi.hoisted(() => vi.fn())
const loadConfigMock = vi.hoisted(() => vi.fn())

vi.mock('@n24q02m/hull', async (importOriginal) => ({
  ...(await importOriginal<typeof Hull>()),
  runHttpServer: runHttpServerMock
}))
vi.mock('../credential-state.js', () => ({
  resolveCredentialState: resolveCredentialStateMock
}))
vi.mock('../tools/helpers/config.js', () => ({
  loadConfig: loadConfigMock
}))
vi.mock('../tools/registry.js', () => ({
  registerTools: registerToolsMock
}))

import { resolveHttpAuth, startHttp, TOKEN_HASH_ENV } from './http.js'

const ALLOWED_OPTION_KEYS = ['auth', 'host', 'openBrowser', 'port', 'serverName']

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  resolveCredentialStateMock.mockResolvedValue('configured')
  loadConfigMock.mockResolvedValue(TEST_ACCOUNTS)
  runHttpServerMock.mockResolvedValue({ host: '127.0.0.1', port: 3000, close: vi.fn().mockResolvedValue(undefined) })
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
})

describe('resolveHttpAuth', () => {
  it('uses token mode whenever a hash is set, on any host', () => {
    expect(resolveHttpAuth('0.0.0.0', TEST_TOKEN_HASH)).toEqual({ mode: 'token', tokenHash: TEST_TOKEN_HASH })
    expect(resolveHttpAuth('127.0.0.1', TEST_TOKEN_HASH)).toEqual({ mode: 'token', tokenHash: TEST_TOKEN_HASH })
  })

  it('treats a whitespace-only hash as unset', () => {
    expect(resolveHttpAuth('127.0.0.1', '   ')).toEqual({ mode: 'no-auth' })
    expect(() => resolveHttpAuth('0.0.0.0', '   ')).toThrow(TOKEN_HASH_ENV)
  })

  it('uses no-auth without a hash on loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(resolveHttpAuth(host, undefined)).toEqual({ mode: 'no-auth' })
    }
  })

  it('fails closed without a hash on non-loopback hosts', () => {
    expect(() => resolveHttpAuth('0.0.0.0', undefined)).toThrow(TOKEN_HASH_ENV)
    expect(() => resolveHttpAuth('192.168.1.10', undefined)).toThrow(/non-loopback host/)
  })
})

describe('startHttp', () => {
  it('refuses to start on 0.0.0.0 without a token hash and never calls runHttpServer', async () => {
    process.env.HOST = '0.0.0.0'
    await expect(startHttp()).rejects.toThrow(TOKEN_HASH_ENV)
    expect(runHttpServerMock).not.toHaveBeenCalled()
  })

  it('passes only the allowed option keys, with token auth when the hash is set', async () => {
    process.env.HOST = '127.0.0.1'
    process.env.PORT = '4321'
    process.env[TOKEN_HASH_ENV] = TEST_TOKEN_HASH

    const started = startHttp()
    await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())

    const [, options] = runHttpServerMock.mock.calls[0]
    expect(Object.keys(options).sort()).toEqual(ALLOWED_OPTION_KEYS)
    expect(options).toMatchObject({
      serverName: 'email',
      host: '127.0.0.1',
      port: 4321,
      openBrowser: false,
      auth: { mode: 'token', tokenHash: TEST_TOKEN_HASH }
    })

    await stopServer(started)
  })

  it('uses no-auth on loopback without a hash, and falls back to MCP_PORT then 0', async () => {
    process.env.HOST = 'localhost'
    process.env.MCP_PORT = '5555'

    const started = startHttp()
    await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())

    const [, options] = runHttpServerMock.mock.calls[0]
    expect(options).toMatchObject({ host: 'localhost', port: 5555, auth: { mode: 'no-auth' } })
    await stopServer(started)
  })

  it('auto-assigns a port when PORT and MCP_PORT are both unset', async () => {
    process.env.HOST = '127.0.0.1'

    const started = startHttp()
    await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())

    expect(runHttpServerMock.mock.calls[0][1]).toMatchObject({ port: 0 })
    await stopServer(started)
  })

  it('registers tools with the startup accounts through the server factory', async () => {
    process.env.HOST = '127.0.0.1'

    const started = startHttp()
    await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())

    const [serverFactory] = runHttpServerMock.mock.calls[0]
    serverFactory()
    expect(registerToolsMock).toHaveBeenCalledWith(expect.anything(), TEST_ACCOUNTS)
    await stopServer(started)
  })
})

/**
 * Fire the shutdown listener that `startHttp` just registered, so the promise
 * resolves without sending a real signal to the test process.
 */
async function stopServer(started: Promise<void>): Promise<void> {
  const sigterm = process.listeners('SIGTERM').at(-1)
  const sigint = process.listeners('SIGINT').at(-1)
  for (const listener of [sigterm, sigint]) {
    if (listener) {
      listener()
      process.removeListener('SIGTERM', listener as () => void)
      process.removeListener('SIGINT', listener as () => void)
    }
  }
  await started
}
