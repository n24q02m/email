/**
 * email MCP Server Starter
 *
 * Wired via hull's buildCli: every MCP tool is also a console subcommand
 * (`email messages search --query UNREAD --json`, `email folders list`, ...)
 * through `toolCliHandlers()`, which routes to the same dispatch table the
 * server registers. `auth`/`logout` route to the OAuth2 device-code CLI, and
 * bare/flag argv starts the MCP server (hull built-ins such as config, doctor,
 * --version, -h remain available).
 */

import { buildCli } from '@n24q02m/hull'
import { runAuth, runLogout } from '../src/auth-cli.js'
import { STORE_PLUGIN } from '../src/data-dir.js'
import { migrateLegacyData } from '../src/data-dir-migration.js'
import { getVersion, initServer } from '../src/init-server.js'
import { printCliHelp, toolCliHandlers } from '../src/tool-cli.js'

const SERVER_NAME = 'email'

/**
 * `serve` entry point for `buildCli` (bare/flag argv routes here).
 *
 * `initServer()` already blocks until shutdown for http mode
 * (`transports/http.ts` waits on its own SIGINT/SIGTERM handler before
 * resolving), but for stdio mode `server.connect(transport)` resolves the
 * instant the stdin listener attaches, not once the session ends. If this
 * function returned right there, buildCli's
 * `.then((code) => process.exit(code))` would kill the process immediately
 * after startup. So stdio keeps this promise pending until SIGINT/SIGTERM,
 * mirroring the shutdown-wait pattern http already uses.
 */
async function serve(): Promise<number | undefined> {
  try {
    await initServer()
  } catch (error) {
    console.error('Failed to start server:', error)
    return 1
  }

  const isHttp =
    process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http' || process.env.TRANSPORT_MODE === 'http'
  if (isHttp) return 0

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.error('\nShutting down email MCP Server')
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  return undefined
}

const argv = process.argv.slice(2)

// Before buildCli parses argv: its built-in `config`, `status` and `doctor`
// commands read the credential store, and the pre-rename `tokens.json` and hull
// blob have to move across first. The CLI promise stays pending for the life of
// the server, so it must not be awaited at module scope.
void (async () => {
  await migrateLegacyData()

  // `--help` is answered here, before buildCli sees the argv: buildCli prints one
  // flat list of every handler, which cannot show tool commands apart from
  // operator commands. Everything else still goes through buildCli.
  if (argv[0] === '-h' || argv[0] === '--help') {
    printCliHelp(SERVER_NAME)
    process.exit(0)
  }

  return buildCli(SERVER_NAME, {
    serve,
    version: getVersion(),
    pluginName: STORE_PLUGIN,
    extra: {
      auth: async () => {
        await runAuth()
        return 0
      },
      logout: async () => {
        await runLogout()
        return 0
      },
      relay: async () => {
        console.error('relay was removed; run `email auth` (see README)')
        return 2
      },
      ...toolCliHandlers()
    }
  })(argv)
})().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // An unreadable or unmigratable pre-rename store must stop startup, not leave
    // a server running that reports "not configured" over still-present tokens.
    console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
)
