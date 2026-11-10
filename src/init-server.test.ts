import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const startHttpMock = vi.fn()
const connectMock = vi.fn().mockResolvedValue(undefined)
const ServerCtorMock = vi.fn(function (this: any, _info: unknown, _opts: unknown) {
  this.connect = connectMock
  this.setRequestHandler = vi.fn()
})
const StdioServerTransportCtorMock = vi.fn(function (this: any) {})
const registerToolsMock = vi.fn()
const resolveCredentialStateMock = vi.fn().mockResolvedValue('configured')
const loadConfigMock = vi.fn().mockResolvedValue([])
const discoverAccountsFileMock = vi.fn().mockResolvedValue(null)

vi.mock('./transports/http.js', () => ({
  startHttp: startHttpMock
}))

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: ServerCtorMock
}))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: StdioServerTransportCtorMock
}))

vi.mock('./tools/registry.js', () => ({
  registerTools: registerToolsMock
}))

vi.mock('./credential-state.js', () => ({
  resolveCredentialState: resolveCredentialStateMock
}))

vi.mock('./tools/helpers/config.js', () => ({
  loadConfig: loadConfigMock
}))

vi.mock('./tools/helpers/accounts-file.js', () => ({
  discoverAccountsFile: discoverAccountsFileMock
}))

describe('initServer', () => {
  const originalEnv = process.env
  const originalArgv = process.argv
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    process.env = { ...originalEnv }
    process.argv = [...originalArgv]
    delete process.env.MCP_TRANSPORT
    delete process.env.TRANSPORT_MODE
    delete process.env.EMAIL_CREDENTIALS
    delete process.env.EMAIL_USER
    delete process.env.EMAIL_APP_PASSWORD
    // No ambient accounts file: the file cases below drive the mock instead.
    process.env.EMAIL_ACCOUNTS_FILE = 'off'
    discoverAccountsFileMock.mockResolvedValue(null)
    // process.exit is mocked to throw so we can detect calls without
    // actually terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    process.env = originalEnv
    process.argv = originalArgv
    exitSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('starts HTTP transport when --http flag is set', async () => {
    process.argv = [process.argv[0], 'main.js', '--http']
    const { initServer } = await import('./init-server.js')
    await initServer()
    expect(startHttpMock).toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('starts HTTP transport when MCP_TRANSPORT=http', async () => {
    process.env.MCP_TRANSPORT = 'http'
    const { initServer } = await import('./init-server.js')
    await initServer()
    expect(startHttpMock).toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('starts HTTP transport when TRANSPORT_MODE=http', async () => {
    process.env.TRANSPORT_MODE = 'http'
    const { initServer } = await import('./init-server.js')
    await initServer()
    expect(startHttpMock).toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('starts stdio transport by default when EMAIL_CREDENTIALS set', async () => {
    process.env.EMAIL_CREDENTIALS = 'user@example.com:app-pass'
    const { initServer } = await import('./init-server.js')
    await initServer()
    expect(ServerCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'email' }),
      expect.objectContaining({ capabilities: expect.any(Object) })
    )
    expect(registerToolsMock).toHaveBeenCalled()
    expect(StdioServerTransportCtorMock).toHaveBeenCalled()
    expect(connectMock).toHaveBeenCalled()
    expect(startHttpMock).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('exits with code 1 when neither EMAIL_CREDENTIALS nor EMAIL_USER+APP_PASSWORD set', async () => {
    const { initServer } = await import('./init-server.js')
    await expect(initServer()).rejects.toThrow('process.exit(1)')

    expect(exitSpy).toHaveBeenCalledWith(1)
    const stderrOutput = stderrSpy.mock.calls.map((c: any) => String(c[0])).join('')
    expect(stderrOutput).toContain('Missing required env vars for stdio mode')
    expect(stderrOutput).toContain('EMAIL_CREDENTIALS')
    expect(stderrOutput).toContain('EMAIL_USER')
    expect(stderrOutput).toContain('EMAIL_APP_PASSWORD')
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('starts stdio when EMAIL_USER + EMAIL_APP_PASSWORD set (without EMAIL_CREDENTIALS)', async () => {
    process.env.EMAIL_USER = 'user@example.com'
    process.env.EMAIL_APP_PASSWORD = 'app-pass'
    const { initServer } = await import('./init-server.js')
    await initServer()
    expect(connectMock).toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('starts stdio when only an accounts file configures the server', async () => {
    discoverAccountsFileMock.mockResolvedValue({ path: '/tmp/accounts.toml', explicit: true })
    const { initServer } = await import('./init-server.js')
    await initServer()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(resolveCredentialStateMock).toHaveBeenCalled()
    expect(connectMock).toHaveBeenCalled()
  })

  it('mentions EMAIL_ACCOUNTS_FILE in the missing-credentials message', async () => {
    const { initServer } = await import('./init-server.js')
    await expect(initServer()).rejects.toThrow('process.exit(1)')

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => String(c[0])).join('')
    expect(stderrOutput).toContain('EMAIL_ACCOUNTS_FILE')
  })
})
