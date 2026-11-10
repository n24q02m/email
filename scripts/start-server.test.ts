import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAuth, runLogout } from '../src/auth-cli.js'
import { initServer } from '../src/init-server.js'

vi.mock('../src/auth-cli.js', () => ({
  runAuth: vi.fn(),
  runLogout: vi.fn()
}))

vi.mock('../src/init-server.js', () => ({
  initServer: vi.fn(),
  getVersion: vi.fn(() => '0.0.0-test')
}))

// Dynamic CLI imports can contend with the full Vitest worker pool. Keep this
// suite bounded, but allow the real startup path more than the 5s unit default.
describe('start-server (buildCli wiring)', { timeout: 30_000 }, () => {
  const originalArgv = process.argv
  const originalExit = process.exit
  const originalConsoleError = console.error
  let onceSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    const home = mkdtempSync(join(tmpdir(), 'email-cli-test-'))
    // Both the credential blob (hull home) and the token file (EMAIL_DATA_DIR) must
    // stay inside the temp tree: startup migrates a pre-rename store before buildCli.
    setHomeDirForTesting(home)
    process.env.EMAIL_DATA_DIR = home

    process.argv = ['node', 'scripts/start-server.ts']
    process.exit = vi.fn((_code) => undefined as never) as any
    console.error = vi.fn()
    onceSpy = vi.spyOn(process, 'once').mockImplementation((_event, _listener) => process)
  })

  afterEach(() => {
    process.argv = originalArgv
    process.exit = originalExit
    console.error = originalConsoleError
    setHomeDirForTesting(null)
    delete process.env.EMAIL_DATA_DIR
    vi.restoreAllMocks()
  })

  it('routes the "auth" subcommand to runAuth and does not start the server', async () => {
    process.argv.push('auth')
    vi.mocked(runAuth).mockResolvedValue(undefined)

    await import('./start-server.js')
    await vi.waitFor(() => expect(runAuth).toHaveBeenCalled())

    expect(runAuth).toHaveBeenCalled()
    expect(initServer).not.toHaveBeenCalled()
    expect(process.exit).toHaveBeenCalledWith(0)
  })

  it('routes the "logout" subcommand to runLogout and does not start the server', async () => {
    process.argv.push('logout')
    vi.mocked(runLogout).mockResolvedValue(undefined)

    await import('./start-server.js')
    await vi.waitFor(() => expect(runLogout).toHaveBeenCalled())

    expect(runLogout).toHaveBeenCalled()
    expect(initServer).not.toHaveBeenCalled()
    expect(process.exit).toHaveBeenCalledWith(0)
  })

  it('refuses the removed "relay" subcommand with exit 2 and a pointer to auth', async () => {
    process.argv.push('relay')

    await import('./start-server.js')
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(2))

    expect(console.error).toHaveBeenCalledWith('relay was removed; run `email auth` (see README)')
    expect(runAuth).not.toHaveBeenCalled()
    expect(initServer).not.toHaveBeenCalled()
  })

  it('starts the server and registers SIGINT/SIGTERM when no subcommand is given', async () => {
    vi.mocked(initServer).mockResolvedValue(undefined as any)

    await import('./start-server.js')
    await vi.waitFor(() => expect(initServer).toHaveBeenCalled())

    expect(runAuth).not.toHaveBeenCalled()
    expect(initServer).toHaveBeenCalled()
    expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(onceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
  })

  it('does not exit right after initServer resolves (stdio must stay alive until shutdown)', async () => {
    // Regression guard: Server.connect() (inside initServer) resolves once
    // the transport starts listening, not once the session ends. If
    // `serve()` returned right there, buildCli's own
    // `.then((code) => process.exit(code))` would kill the process
    // immediately after startup instead of keeping the server running.
    vi.mocked(initServer).mockResolvedValue(undefined as any)

    await import('./start-server.js')
    await vi.waitFor(() => expect(initServer).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(process.exit).not.toHaveBeenCalled()
  })

  it('exits 0 once SIGINT fires after the server starts', async () => {
    vi.mocked(initServer).mockResolvedValue(undefined as any)

    let sigintHandler: (() => void) | undefined
    onceSpy.mockImplementation((event: string, listener: (...args: any[]) => void) => {
      if (event === 'SIGINT') sigintHandler = listener as () => void
      return process
    })

    await import('./start-server.js')
    await vi.waitFor(() => expect(initServer).toHaveBeenCalled())
    await vi.waitFor(() => expect(sigintHandler).toBeDefined())

    sigintHandler?.()
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled())

    expect(console.error).toHaveBeenCalledWith('\nShutting down email MCP Server')
    expect(process.exit).toHaveBeenCalledWith(0)
  })

  it('exits with 1 if initServer throws', async () => {
    const error = new Error('Init failed')
    vi.mocked(initServer).mockRejectedValue(error)

    await import('./start-server.js')
    await vi.waitFor(() => expect(initServer).toHaveBeenCalled())
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled())

    expect(console.error).toHaveBeenCalledWith('Failed to start server:', error)
    expect(process.exit).toHaveBeenCalledWith(1)
  })

  it('does not start the server for --http (isHttp resolves immediately, no SIGINT wait)', async () => {
    process.argv.push('--http')
    vi.mocked(initServer).mockResolvedValue(undefined as any)

    await import('./start-server.js')
    await vi.waitFor(() => expect(initServer).toHaveBeenCalled())
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0))

    // http mode's initServer() already blocks until its own shutdown
    // completes (transports/http.ts), so serve() must not add a redundant
    // SIGINT wait -- that would hang the process after a graceful http
    // shutdown, since the http path's own `process.once('SIGINT', ...)`
    // handler already consumed the signal.
    expect(onceSpy).not.toHaveBeenCalled()
  })

  it('prints version and exits 0 without starting the server', async () => {
    process.argv.push('--version')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await import('./start-server.js')
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled())

    expect(logSpy).toHaveBeenCalledWith('email 0.0.0-test')
    expect(process.exit).toHaveBeenCalledWith(0)
    expect(initServer).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('routes config status to the built-in handler (isolated store dir: not configured)', async () => {
    process.argv.push('config', 'status')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await import('./start-server.js')
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled())

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('email: not configured'))
    expect(process.exit).toHaveBeenCalledWith(0)
    expect(initServer).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('migrates the pre-rename credential store (better-email) before config status reads it', async () => {
    // Releases before the rename saved under the PerPluginStore slug 'better-email'
    // (~/.better-email). Startup has to copy that blob into the current store, or an
    // existing install would report "not configured" after the upgrade.
    await new PerPluginStore('better-email').save({ EMAIL_CREDENTIALS: 'user@example.com:app-password' })
    process.argv.push('config', 'status')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await import('./start-server.js')
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalled())

    expect(logSpy).toHaveBeenCalledWith('email: configured (source: file)')
    expect(process.exit).toHaveBeenCalledWith(0)
    logSpy.mockRestore()
  })

  it('migrates a pre-rename token file (better-email-mcp) into the current data dir', async () => {
    // The other half of the same migration: `email auth` used to save tokens under
    // ~/.better-email-mcp/tokens.json; the CLI must see them under ~/.email without
    // asking the user to authenticate again.
    mkdirSync(join(process.env.EMAIL_DATA_DIR as string, '.better-email-mcp'), { recursive: true })
    writeFileSync(
      join(process.env.EMAIL_DATA_DIR as string, '.better-email-mcp', 'tokens.json'),
      JSON.stringify({
        'user@outlook.com': { accessToken: 'at', refreshToken: 'rt', expiresAt: 1000, clientId: 'cid' }
      })
    )
    process.argv.push('logout', 'user@outlook.com')
    vi.mocked(runLogout).mockResolvedValue(undefined)

    await import('./start-server.js')
    await vi.waitFor(() => expect(runLogout).toHaveBeenCalled())

    expect(existsSync(join(process.env.EMAIL_DATA_DIR as string, '.email', 'tokens.json'))).toBe(true)
    expect(existsSync(join(process.env.EMAIL_DATA_DIR as string, '.better-email-mcp', 'tokens.json'))).toBe(true)
  })
})
