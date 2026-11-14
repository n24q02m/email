/**
 * email MCP Server — Entry point
 *
 * Transport selection (default flipped 2026-05-01 per spec
 * 2026-05-01-stdio-pure-http-multiuser.md §5.2.1):
 *  - stdio (DEFAULT): MCP SDK StdioServerTransport directly. Requires
 *    EMAIL_PROVIDER + EMAIL_USER + EMAIL_APP_PASSWORD env vars.
 *  - http: Opt-in via `--http`, `MCP_TRANSPORT=http`, or `TRANSPORT_MODE=http`.
 *    Streamable HTTP; auth via MCP_AUTH_MODE: multi (hull users.toml, per-namespace
 *    accounts), token (MCP_AUTH_TOKEN_HASH / EMAIL_MCP_TOKEN_HASH) or loopback no-auth
 *    (see transports/http.ts).
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveCredentialState } from './credential-state.js'
import { discoverAccountsFile } from './tools/helpers/accounts-file.js'
import { loadConfig } from './tools/helpers/config.js'
import { registerTools } from './tools/registry.js'

const SERVER_NAME = 'email'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function getVersion(): string {
  // Walk up from __dirname to find package.json.
  // Needed because __dirname differs between contexts:
  //   - src/          (dev via tsx)
  //   - build/src/    (tsc output, referenced by "main" in package.json)
  //   - bin/          (esbuild bundle)
  try {
    let dir = __dirname
    for (let i = 0; i < 5; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        if (pkg.name === '@n24q02m/email') {
          return pkg.version ?? '0.0.0'
        }
      }
      dir = dirname(dir)
    }
    return '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function initServer() {
  const isHttp =
    process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http' || process.env.TRANSPORT_MODE === 'http'

  if (isHttp) {
    const { startHttp } = await import('./transports/http.js')
    await startHttp()
    return
  }

  // Default: stdio mode. credential-state.ts:loadCredsFromEnv accepts ANY of:
  //   (a) EMAIL_ACCOUNTS_FILE (or <data dir>/accounts.toml) -- multi-account,
  //   (b) EMAIL_CREDENTIALS directly ("user:app-password" or multi-account
  //       "user1:pass1,user2:pass2"), OR
  //   (c) EMAIL_USER + EMAIL_APP_PASSWORD pair (merged into EMAIL_CREDENTIALS at boot).
  // Match handler to loader semantics.
  const hasAccountsFile = (await discoverAccountsFile()) !== null
  const hasCredentials = !!process.env.EMAIL_CREDENTIALS
  const hasUserAppPair = !!(process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD)
  if (!hasAccountsFile && !hasCredentials && !hasUserAppPair) {
    const msg = `[${SERVER_NAME}] Missing required env vars for stdio mode.

stdio mode reads credentials from ANY of:
  - EMAIL_ACCOUNTS_FILE (an accounts.toml, or <data dir>/accounts.toml by default),
  - EMAIL_CREDENTIALS (combined "user:app-password" or "user1:pass1,user2:pass2"), OR
  - EMAIL_USER + EMAIL_APP_PASSWORD pair (merged at boot)

Options:
  1. Set env in plugin config:
     {"command": "npx", "args": [...], "env": {"EMAIL_CREDENTIALS": "user:app-password"}}
     OR
     {"command": "npx", "args": [...], "env": {"EMAIL_ACCOUNTS_FILE": "/path/to/accounts.toml"}}
     OR
     {"command": "npx", "args": [...], "env": {"EMAIL_USER": "...", "EMAIL_APP_PASSWORD": "..."}}

  2. Switch to HTTP mode with a shared bearer token: set MCP_AUTH_TOKEN_HASH (mint with: printf '%s' "$TOKEN" | email token hash), or run: email auth outlook <address>

Documentation: https://docs.n24q02m.com/servers/email/
`
    process.stderr.write(msg)
    process.exit(1)
  }

  // Direct MCP SDK stdio transport (no daemon proxy hop).
  await resolveCredentialState()
  const accounts = await loadConfig()
  const server = new Server(
    { name: SERVER_NAME, version: getVersion() },
    { capabilities: { tools: {}, resources: {} } }
  )
  registerTools(server, accounts)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[${SERVER_NAME}] Server started in stdio mode (v${getVersion()})`)
}
