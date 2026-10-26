/**
 * HTTP transport: single-user Streamable HTTP server on hull's `runHttpServer`.
 *
 * Auth is one shared bearer token. The operator supplies only its scrypt hash
 * in `EMAIL_MCP_TOKEN_HASH` (mint with the `token hash` subcommand); the bearer
 * itself never goes into config. With no hash, the server runs unauthenticated
 * only on a loopback bind; any other bind address without a hash fails closed.
 *
 * Accounts come from the same startup resolution as stdio:
 *  - `resolveCredentialState()` loads EMAIL_CREDENTIALS / encrypted config.
 *  - `loadConfig()` yields the account list handed to `registerTools`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type HttpAuthConfig, isLoopbackHost, type RunHttpServerOptions, runHttpServer } from '@n24q02m/hull'
import { resolveCredentialState } from '../credential-state.js'
import { getVersion } from '../init-server.js'
import { loadConfig } from '../tools/helpers/config.js'
import { registerTools } from '../tools/registry.js'

const SERVER_NAME = 'email'
/** Env var holding the scrypt hash of the shared bearer token. */
export const TOKEN_HASH_ENV = 'EMAIL_MCP_TOKEN_HASH'

/**
 * Pick the hull auth mode for a bind host.
 * - Hash present: token mode, on any host.
 * - No hash, loopback host: no-auth (hull re-checks loopback itself).
 * - No hash, other host: throws; the server never listens unauthenticated off loopback.
 */
export function resolveHttpAuth(host: string, tokenHash: string | undefined): HttpAuthConfig {
  const hash = tokenHash?.trim()
  if (hash) return { mode: 'token', tokenHash: hash }
  if (isLoopbackHost(host)) return { mode: 'no-auth' }
  throw new Error(
    `[${SERVER_NAME}] Refusing to serve HTTP on non-loopback host "${host}" without ${TOKEN_HASH_ENV}. ` +
      `Set ${TOKEN_HASH_ENV} to a scrypt token hash (mint with the "token hash" subcommand), ` +
      'or bind to loopback with HOST=127.0.0.1.'
  )
}

export async function startHttp(): Promise<void> {
  const host = process.env.HOST || '0.0.0.0'
  const auth = resolveHttpAuth(host, process.env[TOKEN_HASH_ENV])

  await resolveCredentialState()
  const accounts = await loadConfig()

  const serverFactory = (): McpServer => {
    const server = new Server(
      { name: `@n24q02m/${SERVER_NAME}`, version: getVersion() },
      { capabilities: { tools: {}, resources: {} } }
    )
    registerTools(server, accounts)
    return server as unknown as McpServer
  }

  // Port resolution order: PORT (explicit) -> MCP_PORT (Cloudflare container
  // convention) -> 0 (OS-assigned random).
  const port = process.env.PORT
    ? Number.parseInt(process.env.PORT, 10)
    : process.env.MCP_PORT
      ? Number.parseInt(process.env.MCP_PORT, 10)
      : 0

  const options: RunHttpServerOptions = {
    serverName: SERVER_NAME,
    port,
    host,
    // No setup page exists in token mode, so there is no URL to open.
    openBrowser: false,
    auth
  }
  const handle = await runHttpServer(serverFactory, options)

  console.error(`[${SERVER_NAME}] HTTP mode on http://${handle.host}:${handle.port}/mcp (auth: ${auth.mode})`)
  if (accounts.length === 0) {
    console.error(
      `[${SERVER_NAME}] No email accounts configured. Set EMAIL_CREDENTIALS or EMAIL_USER + EMAIL_APP_PASSWORD, ` +
        `or run "email auth outlook <address>".`
    )
  }

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await handle.close()
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}
