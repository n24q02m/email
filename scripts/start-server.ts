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
import { resolveProfile } from '@n24q02m/hull/storage'
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

function extractProfileFlag(rawArgv: string[]): { profile: string | undefined; rest: string[] } {
  let profile: string | undefined
  const rest: string[] = []
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i]
    if (arg === '--') {
      rest.push(...rawArgv.slice(i))
      break
    }
    if (arg === '--profile') {
      if (i + 1 >= rawArgv.length) {
        throw new Error('Missing value for --profile')
      }
      profile = rawArgv[++i]
      continue
    }
    if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
      continue
    }
    rest.push(arg)
  }
  return { profile, rest }
}

const argv = process.argv.slice(2)

// Before buildCli parses argv: resolve any --profile selection into EMAIL_PROFILE,
// then migrate v0/v1 state into `~/.n24q02m/email/` before built-ins or tool
// handlers read credentials or tokens.
void (async () => {
  const { profile: explicitProfile, rest } = extractProfileFlag(argv)
  const effectiveProfile = resolveProfile(STORE_PLUGIN, explicitProfile)
  if (
    explicitProfile !== undefined ||
    process.env.EMAIL_PROFILE !== undefined ||
    process.env.HULL_PROFILE !== undefined
  ) {
    process.env.EMAIL_PROFILE = effectiveProfile
  }

  await migrateLegacyData()

  // `--help` is answered here, before buildCli sees the argv: buildCli prints one
  // flat list of every handler, which cannot show tool commands apart from
  // operator commands. Everything else still goes through buildCli.
  if (rest[0] === '-h' || rest[0] === '--help') {
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
      ...toolCliHandlers()
    }
  })(rest)
})().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // An unreadable or unmigratable pre-rename store must stop startup, not leave
    // a server running that reports "not configured" over still-present tokens.
    console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
)
