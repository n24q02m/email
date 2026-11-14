/**
 * HTTP transport: Streamable HTTP server on hull's `runHttpServer`.
 *
 * Auth modes (`MCP_AUTH_MODE`):
 *  - `multi`: hull's users.toml token table (`MCP_USERS_FILE`, default
 *    `~/.hull/users.toml`). Each bearer token maps to a user row whose
 *    `namespace` scopes everything the caller can reach: its mailboxes come from
 *    `<data dir>/users/<namespace>/accounts.toml` and its Outlook grants from
 *    `<data dir>/users/<namespace>/tokens.json`, resolved on every tool call.
 *    The server-wide account sources are not served to anyone in this mode.
 *    A missing or unknown token is answered 401 by hull before any tool runs.
 *  - `token`: one shared bearer token (`MCP_AUTH_TOKEN_HASH`, or the older
 *    `EMAIL_MCP_TOKEN_HASH`; optional `MCP_RPM` cap). One principal: the
 *    server-wide accounts, resolved once at startup.
 *  - `no-auth`: loopback only (hull refuses any other bind). One principal.
 *  - unset: the pre-multi behaviour. A token hash selects `token`; with none,
 *    a loopback bind runs `no-auth` and any other bind fails closed.
 *
 * The operator supplies only scrypt hashes (mint with the `token hash`
 * subcommand); bearer tokens never go into config.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type HttpAuthConfig, isLoopbackHost, type RunHttpServerOptions, runHttpServer } from '@n24q02m/hull'
import { resolveCredentialState } from '../credential-state.js'
import { getVersion } from '../init-server.js'
import { discoverAccountsFile } from '../tools/helpers/accounts-file.js'
import { type AccountConfig, loadCallerConfig, loadConfig } from '../tools/helpers/config.js'
import { type RegisterToolsOptions, registerTools } from '../tools/registry.js'

const SERVER_NAME = 'email'
/** Env var selecting the auth mode: `multi`, `token` or `no-auth`. */
export const AUTH_MODE_ENV = 'MCP_AUTH_MODE'
/** Env var naming the users.toml for `multi` mode. */
export const USERS_FILE_ENV = 'MCP_USERS_FILE'
/** Env var holding the scrypt hash of the shared bearer token (`token` mode). */
export const TOKEN_HASH_ENV = 'MCP_AUTH_TOKEN_HASH'
/** Older name of `MCP_AUTH_TOKEN_HASH`, still honoured. */
export const LEGACY_TOKEN_HASH_ENV = 'EMAIL_MCP_TOKEN_HASH'
/** Env var with an optional per-minute request cap for `token` mode. */
export const RPM_ENV = 'MCP_RPM'

function tokenHashFrom(env: NodeJS.ProcessEnv): string | undefined {
  return env[TOKEN_HASH_ENV]?.trim() || env[LEGACY_TOKEN_HASH_ENV]?.trim() || undefined
}

function rpmFrom(env: NodeJS.ProcessEnv): number | null {
  const raw = env[RPM_ENV]?.trim()
  return raw ? Number.parseInt(raw, 10) : null
}

/**
 * Pick the hull auth config for a bind host and environment.
 * - `MCP_AUTH_MODE=multi`: users.toml token table.
 * - `MCP_AUTH_MODE=token`: shared token; a hash is required.
 * - `MCP_AUTH_MODE=no-auth`: no auth (hull enforces a loopback bind).
 * - unset: a hash selects token mode; else loopback runs no-auth and any other
 *   host throws, so the server never listens unauthenticated off loopback.
 */
export function resolveHttpAuth(host: string, env: NodeJS.ProcessEnv = process.env): HttpAuthConfig {
  const mode = env[AUTH_MODE_ENV]?.trim()
  const tokenHash = tokenHashFrom(env)
  switch (mode) {
    case 'multi':
      return { mode: 'multi', usersFile: env[USERS_FILE_ENV]?.trim() || undefined }
    case 'token':
      if (!tokenHash) {
        throw new Error(
          `[${SERVER_NAME}] ${AUTH_MODE_ENV}=token requires ${TOKEN_HASH_ENV} (mint with the "token hash" subcommand)`
        )
      }
      return { mode: 'token', tokenHash, rpm: rpmFrom(env) }
    case 'no-auth':
      return { mode: 'no-auth' }
    case undefined:
    case '':
      if (tokenHash) return { mode: 'token', tokenHash, rpm: rpmFrom(env) }
      if (isLoopbackHost(host)) return { mode: 'no-auth' }
      throw new Error(
        `[${SERVER_NAME}] Refusing to serve HTTP on non-loopback host "${host}" without auth. ` +
          `Set ${AUTH_MODE_ENV}=multi with a users.toml (${USERS_FILE_ENV}), or ${TOKEN_HASH_ENV} to a scrypt token ` +
          'hash (mint with the "token hash" subcommand), or bind to loopback with HOST=127.0.0.1.'
      )
    default:
      throw new Error(`[${SERVER_NAME}] Unknown ${AUTH_MODE_ENV} "${mode}" (expected multi, token, or no-auth)`)
  }
}

/** Whether the operator configured server-wide accounts that multi mode will not serve. */
async function hasServerWideAccounts(): Promise<boolean> {
  let accountsFile: boolean
  try {
    accountsFile = (await discoverAccountsFile()) !== null
  } catch {
    // A named file that is missing still counts as configured; multi mode never reads it.
    accountsFile = true
  }
  return accountsFile || !!process.env.EMAIL_CREDENTIALS || !!(process.env.EMAIL_USER && process.env.EMAIL_APP_PASSWORD)
}

export async function startHttp(): Promise<void> {
  const host = process.env.HOST || '0.0.0.0'
  const auth = resolveHttpAuth(host)

  let accounts: AccountConfig[] = []
  let toolOptions: RegisterToolsOptions = {}
  if (auth.mode === 'multi') {
    // Every caller gets only its own namespace, re-read per tool call.
    toolOptions = { resolveAccounts: loadCallerConfig }
    if (await hasServerWideAccounts()) {
      console.error(
        `[${SERVER_NAME}] Multi-user mode ignores the server-wide accounts (EMAIL_ACCOUNTS_FILE / EMAIL_CREDENTIALS); ` +
          "put each user's mailboxes in users/<namespace>/accounts.toml under the data directory."
      )
    }
  } else {
    await resolveCredentialState()
    accounts = await loadConfig()
  }

  const serverFactory = (): McpServer => {
    const server = new Server(
      { name: `@n24q02m/${SERVER_NAME}`, version: getVersion() },
      { capabilities: { tools: {}, resources: {} } }
    )
    registerTools(server, accounts, toolOptions)
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
    auth
  }
  const handle = await runHttpServer(serverFactory, options)

  console.error(`[${SERVER_NAME}] HTTP mode on http://${handle.host}:${handle.port}/mcp (auth: ${auth.mode})`)
  if (auth.mode !== 'multi' && accounts.length === 0) {
    console.error(
      `[${SERVER_NAME}] No email accounts configured. Set EMAIL_ACCOUNTS_FILE (accounts.toml), ` +
        `EMAIL_CREDENTIALS or EMAIL_USER + EMAIL_APP_PASSWORD, or run "email auth outlook <address>".`
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
