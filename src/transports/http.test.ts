import type * as Hull from '@n24q02m/hull'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_TOKEN_HASH = 'test-token-hash-not-a-secret'
const TEST_ACCOUNTS = [{ id: 'acct-1' }]
const ENV_KEYS = [
  'HOST',
  'PORT',
  'MCP_PORT',
  'EMAIL_MCP_TOKEN_HASH',
  'MCP_AUTH_TOKEN_HASH',
  'MCP_AUTH_MODE',
  'MCP_USERS_FILE',
  'MCP_RPM',
  'EMAIL_CREDENTIALS',
  'EMAIL_USER',
  'EMAIL_APP_PASSWORD'
] as const

const runHttpServerMock = vi.hoisted(() => vi.fn())
const registerToolsMock = vi.hoisted(() => vi.fn())
const resolveCredentialStateMock = vi.hoisted(() => vi.fn())
const loadConfigMock = vi.hoisted(() => vi.fn())
const loadCallerConfigMock = vi.hoisted(() => vi.fn())
const discoverAccountsFileMock = vi.hoisted(() => vi.fn())

vi.mock('@n24q02m/hull', async (importOriginal) => ({
  ...(await importOriginal<typeof Hull>()),
  runHttpServer: runHttpServerMock
}))
vi.mock('../credential-state.js', () => ({
  resolveCredentialState: resolveCredentialStateMock
}))
vi.mock('../tools/helpers/config.js', () => ({
  loadConfig: loadConfigMock,
  loadCallerConfig: loadCallerConfigMock
}))
vi.mock('../tools/helpers/accounts-file.js', () => ({
  discoverAccountsFile: discoverAccountsFileMock
}))
vi.mock('../tools/registry.js', () => ({
  registerTools: registerToolsMock
}))

import { LEGACY_TOKEN_HASH_ENV, resolveHttpAuth, startHttp, TOKEN_HASH_ENV } from './http.js'

const ALLOWED_OPTION_KEYS = ['auth', 'host', 'port', 'serverName']

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  resolveCredentialStateMock.mockResolvedValue('configured')
  loadConfigMock.mockResolvedValue(TEST_ACCOUNTS)
  discoverAccountsFileMock.mockResolvedValue(null)
  runHttpServerMock.mockResolvedValue({ host: '127.0.0.1', port: 3000, close: vi.fn().mockResolvedValue(undefined) })
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
})

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars

describe('resolveHttpAuth', () => {
  it('uses token mode whenever a hash is set and no mode is named, on any host', () => {
    for (const name of [TOKEN_HASH_ENV, LEGACY_TOKEN_HASH_ENV]) {
      expect(resolveHttpAuth('0.0.0.0', env({ [name]: TEST_TOKEN_HASH }))).toEqual({
        mode: 'token',
        tokenHash: TEST_TOKEN_HASH,
        rpm: null
      })
      expect(resolveHttpAuth('127.0.0.1', env({ [name]: TEST_TOKEN_HASH }))).toMatchObject({ mode: 'token' })
    }
  })

  it('prefers MCP_AUTH_TOKEN_HASH over the legacy name and reads MCP_RPM', () => {
    const vars = env({ [TOKEN_HASH_ENV]: 'new-hash', [LEGACY_TOKEN_HASH_ENV]: 'old-hash', MCP_RPM: '30' })
    expect(resolveHttpAuth('0.0.0.0', vars)).toEqual({ mode: 'token', tokenHash: 'new-hash', rpm: 30 })
  })

  it('treats a whitespace-only hash as unset', () => {
    expect(resolveHttpAuth('127.0.0.1', env({ [LEGACY_TOKEN_HASH_ENV]: '   ' }))).toEqual({ mode: 'no-auth' })
    expect(() => resolveHttpAuth('0.0.0.0', env({ [LEGACY_TOKEN_HASH_ENV]: '   ' }))).toThrow(TOKEN_HASH_ENV)
  })

  it('uses no-auth without a hash on loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(resolveHttpAuth(host, env({}))).toEqual({ mode: 'no-auth' })
    }
  })

  it('fails closed without a hash on non-loopback hosts', () => {
    expect(() => resolveHttpAuth('0.0.0.0', env({}))).toThrow(TOKEN_HASH_ENV)
    expect(() => resolveHttpAuth('192.168.1.10', env({ MCP_AUTH_MODE: '' }))).toThrow(/non-loopback host/)
  })

  it('selects multi mode with the users file, on any host', () => {
    expect(resolveHttpAuth('0.0.0.0', env({ MCP_AUTH_MODE: 'multi', MCP_USERS_FILE: '/etc/users.toml' }))).toEqual({
      mode: 'multi',
      usersFile: '/etc/users.toml'
    })
    expect(resolveHttpAuth('0.0.0.0', env({ MCP_AUTH_MODE: ' multi ', [TOKEN_HASH_ENV]: 'ignored' }))).toEqual({
      mode: 'multi',
      usersFile: undefined
    })
  })

  it('requires a hash for an explicit token mode', () => {
    expect(() => resolveHttpAuth('127.0.0.1', env({ MCP_AUTH_MODE: 'token' }))).toThrow(/requires MCP_AUTH_TOKEN_HASH/)
    expect(resolveHttpAuth('127.0.0.1', env({ MCP_AUTH_MODE: 'token', [TOKEN_HASH_ENV]: 'h' }))).toEqual({
      mode: 'token',
      tokenHash: 'h',
      rpm: null
    })
  })

  it('passes an explicit no-auth through (hull enforces loopback) and rejects unknown modes', () => {
    expect(resolveHttpAuth('127.0.0.1', env({ MCP_AUTH_MODE: 'no-auth' }))).toEqual({ mode: 'no-auth' })
    expect(() => resolveHttpAuth('127.0.0.1', env({ MCP_AUTH_MODE: 'oauth' }))).toThrow(/Unknown MCP_AUTH_MODE "oauth"/)
  })

  it('reads process.env by default', () => {
    process.env.MCP_AUTH_MODE = 'multi'
    expect(resolveHttpAuth('0.0.0.0')).toEqual({ mode: 'multi', usersFile: undefined })
  })
})

describe('startHttp', () => {
  it('refuses to start on 0.0.0.0 without auth and never calls runHttpServer', async () => {
    process.env.HOST = '0.0.0.0'
    await expect(startHttp()).rejects.toThrow(TOKEN_HASH_ENV)
    expect(runHttpServerMock).not.toHaveBeenCalled()
  })

  it('passes only the allowed option keys, with token auth when the legacy hash is set', async () => {
    process.env.HOST = '127.0.0.1'
    process.env.PORT = '4321'
    process.env[LEGACY_TOKEN_HASH_ENV] = TEST_TOKEN_HASH

    const started = startHttp()
    await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())

    const [, options] = runHttpServerMock.mock.calls[0]
    expect(Object.keys(options).sort()).toEqual(ALLOWED_OPTION_KEYS)
    expect(options).toMatchObject({
      serverName: 'email',
      host: '127.0.0.1',
      port: 4321,
      auth: { mode: 'token', tokenHash: TEST_TOKEN_HASH, rpm: null }
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
    expect(registerToolsMock).toHaveBeenCalledWith(expect.anything(), TEST_ACCOUNTS, {})
    await stopServer(started)
  })

  it('multi mode resolves accounts per call and never loads the server-wide accounts', async () => {
    process.env.HOST = '0.0.0.0'
    process.env.MCP_AUTH_MODE = 'multi'

    const started = startHttp()
    await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())

    const [serverFactory, options] = runHttpServerMock.mock.calls[0]
    expect(options.auth).toEqual({ mode: 'multi', usersFile: undefined })
    serverFactory()
    expect(registerToolsMock).toHaveBeenCalledWith(expect.anything(), [], { resolveAccounts: loadCallerConfigMock })
    expect(resolveCredentialStateMock).not.toHaveBeenCalled()
    expect(loadConfigMock).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('ignores the server-wide accounts'))
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('No email accounts configured'))
    await stopServer(started)
  })

  it.each([
    ['EMAIL_CREDENTIALS', { EMAIL_CREDENTIALS: 'a@example.com:pw' }, null],
    ['EMAIL_USER pair', { EMAIL_USER: 'a@example.com', EMAIL_APP_PASSWORD: 'pw' }, null],
    ['accounts file', {}, { path: '/x/accounts.toml', explicit: true }],
    ['missing named accounts file', {}, 'throw']
  ])('multi mode warns that server-wide accounts (%s) are ignored', async (_label, vars, file) => {
    process.env.HOST = '127.0.0.1'
    process.env.MCP_AUTH_MODE = 'multi'
    Object.assign(process.env, vars)
    if (file === 'throw') discoverAccountsFileMock.mockRejectedValue(new Error('missing'))
    else discoverAccountsFileMock.mockResolvedValue(file)

    const started = startHttp()
    await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ignores the server-wide accounts'))
    await stopServer(started)
  })

  it('warns when token or no-auth mode starts with no accounts', async () => {
    process.env.HOST = '127.0.0.1'
    loadConfigMock.mockResolvedValue([])

    const started = startHttp()
    await vi.waitFor(() => expect(runHttpServerMock).toHaveBeenCalled())
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No email accounts configured'))
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
