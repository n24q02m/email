/**
 * HTTP multi-user mode end to end inside the process: the real `startHttp`,
 * hull's real users.toml token table and Streamable HTTP transport, the real
 * filesystem under a temporary `EMAIL_DATA_DIR`, and an MCP SDK client per user.
 *
 * Nothing here talks to a mail server: isolation is asserted on what each caller
 * can see (`config status`) and on what the server refuses (401, host-side
 * lifecycle actions), which is where a cross-tenant leak would show up.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { hashToken } from '@n24q02m/hull/token-auth'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DATA_DIR_ENV, DATA_DIR_NAME } from '../data-dir.js'
import { runAsNamespace } from '../tenant.js'
import { _resetTokenCache, saveTokens } from '../tools/helpers/oauth2.js'
import { startHttp } from './http.js'

const ALICE_TOKEN = 'alice-test-bearer-not-a-secret'
const BOB_TOKEN = 'bob-test-bearer-not-a-secret'
const ENV_KEYS = [
  DATA_DIR_ENV,
  'HOST',
  'PORT',
  'MCP_PORT',
  'MCP_AUTH_MODE',
  'MCP_USERS_FILE',
  'EMAIL_CREDENTIALS',
  'EMAIL_ACCOUNTS_FILE',
  'EMAIL_MCP_TOKEN_HASH',
  'MCP_AUTH_TOKEN_HASH'
] as const

let root: string
let baseUrl: string
let started: Promise<void>
let savedEnv: Record<string, string | undefined>

function accountsToml(id: string, email: string): string {
  return `[accounts.${id}]\nemail = "${email}"\npassword = "app-password"\nimap_host = "imap.example.com"\n`
}

beforeAll(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  root = mkdtempSync(join(tmpdir(), 'email-multi-user-'))
  const usersDir = join(root, DATA_DIR_NAME, 'users')
  mkdirSync(join(usersDir, 'alice'), { recursive: true })
  mkdirSync(join(usersDir, 'bob'), { recursive: true })
  // Both users name their account `work`: ids are only unique per namespace.
  writeFileSync(join(usersDir, 'alice', 'accounts.toml'), accountsToml('work', 'alice@example.com'))
  writeFileSync(join(usersDir, 'bob', 'accounts.toml'), accountsToml('work', 'bob@example.com'))

  const usersFile = join(root, 'users.toml')
  writeFileSync(
    usersFile,
    [
      '[users.alice]',
      `token_hash = "${await hashToken(ALICE_TOKEN)}"`,
      'namespace = "alice"',
      '[users.bob]',
      `token_hash = "${await hashToken(BOB_TOKEN)}"`,
      'namespace = "bob"',
      '[users.carol]',
      `token_hash = "${await hashToken('carol-test-bearer-not-a-secret')}"`,
      'namespace = "carol"',
      'enabled = false',
      ''
    ].join('\n')
  )

  for (const k of ENV_KEYS) delete process.env[k]
  process.env[DATA_DIR_ENV] = root
  process.env.HOST = '127.0.0.1'
  process.env.MCP_AUTH_MODE = 'multi'
  process.env.MCP_USERS_FILE = usersFile
  // A server-wide account that no multi-user caller may ever see.
  process.env.EMAIL_CREDENTIALS = 'operator@example.com:operator-password:imap.example.com'
  _resetTokenCache()

  // An Outlook grant saved for alice only (what `email auth outlook --user alice` writes).
  await runAsNamespace('alice', () =>
    saveTokens('alice@outlook.com', {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      clientId: 'cid'
    })
  )

  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  started = startHttp()
  await vi.waitFor(
    () => {
      const line = lines.find((l) => l.includes('HTTP mode on http://'))
      expect(line).toBeDefined()
      baseUrl = (line as string).match(/http:\/\/\S+\/mcp/)?.[0] as string
    },
    { timeout: 20_000 }
  )
}, 60_000)

afterAll(async () => {
  const listener = process.listeners('SIGTERM').at(-1)
  if (listener) {
    listener('SIGTERM')
    process.removeListener('SIGTERM', listener as () => void)
  }
  const sigint = process.listeners('SIGINT').at(-1)
  if (sigint) process.removeListener('SIGINT', sigint as () => void)
  await started
  vi.restoreAllMocks()
  _resetTokenCache()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(root, { recursive: true, force: true })
})

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'multi-user-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return client
}

async function configCall(client: Client, action: string): Promise<{ isError?: boolean; text: string; data: any }> {
  const result = (await client.callTool({ name: 'config', arguments: { action } })) as any
  return { isError: result.isError, text: result.content?.[0]?.text ?? '', data: result.structuredContent }
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } }
  })
}

describe('HTTP multi-user mode', () => {
  it('answers 401 without a bearer token and with an unknown one, 403 for a disabled user', async () => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    const missing = await fetch(baseUrl, { method: 'POST', headers, body: initializeBody() })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')

    const wrong = await fetch(baseUrl, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer not-a-known-token' },
      body: initializeBody()
    })
    expect(wrong.status).toBe(401)

    const disabled = await fetch(baseUrl, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer carol-test-bearer-not-a-secret' },
      body: initializeBody()
    })
    expect(disabled.status).toBe(403)
  })

  it('shows each user only the mailboxes of their own namespace', async () => {
    const alice = await connect(ALICE_TOKEN)
    const bob = await connect(BOB_TOKEN)
    try {
      const aliceStatus = await configCall(alice, 'status')
      const bobStatus = await configCall(bob, 'status')

      expect(aliceStatus.data.state).toBe('configured')
      expect(aliceStatus.data.accounts.sort()).toEqual(['alice@example.com', 'alice@outlook.com'])
      expect(bobStatus.data.state).toBe('configured')
      expect(bobStatus.data.accounts).toEqual(['bob@example.com'])

      for (const text of [aliceStatus.text, bobStatus.text]) {
        expect(text).not.toContain('operator@example.com')
      }
      expect(aliceStatus.text).not.toContain('bob@example.com')
      expect(bobStatus.text).not.toContain('alice@')
    } finally {
      await alice.close()
      await bob.close()
    }
  })

  it('refuses server-wide credential lifecycle actions to a caller', async () => {
    const bob = await connect(BOB_TOKEN)
    try {
      for (const action of ['setup_reset', 'setup_complete']) {
        const result = await configCall(bob, action)
        expect(result.isError).toBe(true)
        expect(result.text).toContain('not available to a multi-user caller')
      }
      const start = await configCall(bob, 'setup_start')
      expect(start.data.message).toContain('users/bob/accounts.toml')
      // The refusal did not touch anyone's accounts.
      const status = await configCall(bob, 'status')
      expect(status.data.accounts).toEqual(['bob@example.com'])
    } finally {
      await bob.close()
    }
  })

  it('a caller cannot pick another namespace account by id or address', async () => {
    const bob = await connect(BOB_TOKEN)
    try {
      const result = (await bob.callTool({
        name: 'folders',
        arguments: { action: 'list', account: 'alice@example.com' }
      })) as any
      expect(result.isError).toBe(true)
      const text: string = result.content[0].text
      expect(text).toContain('Account not found: alice@example.com')
      // The suggestion lists the caller's own mailboxes only.
      expect(text).toContain('Available accounts: bob@example.com')
      expect(text).not.toContain('alice@outlook.com')
      expect(text).not.toContain('operator@example.com')
      expect(text).not.toContain('app-password')
    } finally {
      await bob.close()
    }
  })
})
