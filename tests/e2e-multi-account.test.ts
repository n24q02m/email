/**
 * End-to-end account-mode coverage through the real MCP `ClientSession` over
 * stdio (`node bin/cli.mjs`), against a local IMAP endpoint that speaks just
 * enough of the protocol for `imapflow` to log in and list folders.
 *
 * Three things are proven here, and none of them with mocks inside the server:
 *
 *  1. `single` mode: one account in `accounts.toml`; `config status` reports
 *     `mode: "single"` and a single-account action resolves that account
 *     without being told which one.
 *  2. `multi` mode: a two-account file where the second account's password is
 *     wrong. `folders list` still returns the first account's folders and the
 *     second account's entry carries its own error, naming the account.
 *  3. `multi` mode readback: `config status` reports `mode: "multi"` and both
 *     accounts, and an action that must act on one account is rejected with the
 *     accounts to choose from instead of guessing.
 *
 * Run after a build: `bun run test:e2e:accounts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Minimal IMAP endpoint: one mailbox per connection, one password accepted
// ---------------------------------------------------------------------------

const GOOD_PASSWORD = 'right-app-password'
const BAD_PASSWORD = 'wrong-app-password'

interface FakeImap {
  port: number
  close: () => Promise<void>
  /** Users whose LOGIN was accepted, in order. */
  loggedIn: string[]
}

function startFakeImap(): Promise<FakeImap> {
  const loggedIn: string[] = []

  const server = net.createServer((socket) => {
    socket.setNoDelay(true)
    socket.write('* OK [CAPABILITY IMAP4rev1] local test IMAP ready\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\r\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)
        newline = buffer.indexOf('\r\n')

        const parsed = line.match(/^(\S+)\s+(\S+)(.*)$/s)
        if (!parsed) continue
        const [, tag, rawCommand, rest] = parsed
        const command = rawCommand.toUpperCase()
        const reply = (text: string) => socket.write(`${text}\r\n`)

        switch (command) {
          case 'CAPABILITY':
            reply('* CAPABILITY IMAP4rev1')
            reply(`${tag} OK CAPABILITY completed`)
            break
          case 'LOGIN':
            if (rest.includes(BAD_PASSWORD)) {
              reply(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`)
            } else {
              loggedIn.push(rest.trim().split(' ')[0]?.replace(/"/g, '') ?? '')
              reply(`${tag} OK [CAPABILITY IMAP4rev1] logged in`)
            }
            break
          case 'ID':
            reply('* ID ("name" "email-e2e-imap")')
            reply(`${tag} OK ID completed`)
            break
          case 'NAMESPACE':
            reply('* NAMESPACE (("" "/")) NIL NIL')
            reply(`${tag} OK NAMESPACE completed`)
            break
          case 'ENABLE':
            reply('* ENABLED')
            reply(`${tag} OK ENABLE completed`)
            break
          case 'LIST':
            reply('* LIST (\\HasNoChildren) "/" "INBOX"')
            reply(`${tag} OK LIST completed`)
            break
          case 'STATUS':
            reply('* STATUS "INBOX" (MESSAGES 3 UNSEEN 1 UIDNEXT 4 UIDVALIDITY 1)')
            reply(`${tag} OK STATUS completed`)
            break
          case 'SELECT':
          case 'EXAMINE':
            reply('* 3 EXISTS')
            reply('* 0 RECENT')
            reply('* FLAGS (\\Seen \\Flagged)')
            reply('* OK [PERMANENTFLAGS (\\Seen \\Flagged)] flags')
            reply('* OK [UIDVALIDITY 1] uidvalidity')
            reply('* OK [UIDNEXT 4] uidnext')
            reply(`${tag} OK [READ-WRITE] mailbox selected`)
            break
          case 'LOGOUT':
            reply('* BYE logging out')
            reply(`${tag} OK LOGOUT completed`)
            break
          default:
            reply(`${tag} OK ${command} completed`)
        }
      }
    })
    socket.on('error', () => socket.destroy())
  })

  // `Promise.withResolvers` is ES2024; this project's lib is ES2022, so the
  // executor form is the only option here.
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('fake IMAP did not bind a TCP port'))
        return
      }
      resolve({
        port: address.port,
        loggedIn,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

// ---------------------------------------------------------------------------
// MCP session helpers
// ---------------------------------------------------------------------------

/** The subset of an MCP tool result this file reads. */
interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

interface Session {
  client: Client
  transport: StdioClientTransport
  stderr: () => string
}

const CLI = join(process.cwd(), 'bin', 'cli.mjs')

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // The session under test gets its credentials from its own accounts file.
    if (key.startsWith('EMAIL_') || key === 'MCP_TRANSPORT' || key === 'TRANSPORT_MODE') continue
    env[key] = value
  }
  return env
}

async function openSession(env: Record<string, string>): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: { ...baseEnv(), ...env, NODE_ENV: 'test' },
    stderr: 'pipe'
  })

  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  const client = new Client({ name: 'accounts-e2e', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport, stderr: () => stderr }
}

function parseToolJson(result: ToolResult): unknown {
  const text = result.content.map((part) => part.text ?? '').join('\n')
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`No JSON in tool result: ${text}`)
  return JSON.parse(match[0])
}

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text ?? '').join('\n')
}

/** Narrow one parsed JSON value to a record, or `null` when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let fakeImap: FakeImap
let workDir: string
let singleSession: Session
let multiSession: Session

function accountToml(id: string, email: string, password: string, port: number): string {
  return `[accounts.${id}]
email = "${email}"
password = "${password}"
imap_host = "127.0.0.1"
imap_port = ${port}
smtp_host = "127.0.0.1"
smtp_port = 2525
smtp_security = "none"
`
}

beforeAll(async () => {
  fakeImap = await startFakeImap()
  workDir = await mkdtemp(join(tmpdir(), 'email-e2e-accounts-'))

  const singleFile = join(workDir, 'single-accounts.toml')
  const multiFile = join(workDir, 'multi-accounts.toml')
  await writeFile(singleFile, accountToml('only', 'only@example.test', GOOD_PASSWORD, fakeImap.port), 'utf8')
  await writeFile(
    multiFile,
    [
      accountToml('healthy', 'healthy@example.test', GOOD_PASSWORD, fakeImap.port),
      accountToml('broken', 'broken@example.test', BAD_PASSWORD, fakeImap.port)
    ].join('\n'),
    'utf8'
  )

  singleSession = await openSession({
    EMAIL_ACCOUNTS_FILE: singleFile,
    EMAIL_DATA_DIR: join(workDir, 'single-data')
  })
  multiSession = await openSession({
    EMAIL_ACCOUNTS_FILE: multiFile,
    EMAIL_DATA_DIR: join(workDir, 'multi-data')
  })
}, 180_000)

afterAll(async () => {
  await singleSession?.transport.close()
  await multiSession?.transport.close()
  await fakeImap?.close()
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// single mode
// ---------------------------------------------------------------------------

describe('single account mode over stdio', () => {
  it('reports mode single with the one configured account', async () => {
    const result: ToolResult = await singleSession.client.callTool({
      name: 'config',
      arguments: { action: 'status' }
    })

    expect(parseToolJson(result)).toMatchObject({
      action: 'status',
      state: 'configured',
      mode: 'single',
      accounts: ['only@example.test']
    })
  })

  it('resolves the only account for a single-account action without being told', async () => {
    const result: ToolResult = await singleSession.client.callTool({
      name: 'folders',
      arguments: { action: 'status', folder: 'INBOX' }
    })

    expect(parseToolJson(result)).toMatchObject({
      action: 'status',
      account_email: 'only@example.test',
      folder: 'INBOX',
      messages: 3,
      unseen: 1
    })
  })
})

// ---------------------------------------------------------------------------
// multi mode
// ---------------------------------------------------------------------------

describe('multi account mode over stdio', () => {
  it('reports mode multi with both accounts', async () => {
    const result: ToolResult = await multiSession.client.callTool({
      name: 'config',
      arguments: { action: 'status' }
    })

    expect(parseToolJson(result)).toMatchObject({
      action: 'status',
      state: 'configured',
      mode: 'multi',
      accounts: ['healthy@example.test', 'broken@example.test']
    })
  })

  it('keeps the healthy account when the other account password is wrong', async () => {
    const result: ToolResult = await multiSession.client.callTool({
      name: 'folders',
      arguments: { action: 'list' }
    })
    const listing = asRecord(parseToolJson(result))
    if (!listing) throw new Error(`folders list returned no object: ${resultText(result)}`)

    expect(listing.total_accounts).toBe(2)
    const accounts = Array.isArray(listing.accounts) ? listing.accounts : []
    expect(accounts).toHaveLength(2)

    // The healthy mailbox still answers with real folders.
    expect(accounts[0]).toMatchObject({
      account_id: 'healthy',
      account_email: 'healthy@example.test',
      folders: [{ path: 'INBOX' }]
    })

    // The failing mailbox gets its own entry, named, with the server's reason.
    const broken = asRecord(accounts[1])
    expect(broken).toMatchObject({
      account_id: 'broken',
      account_email: 'broken@example.test',
      folders: []
    })
    expect(String(broken?.error)).toContain('IMAP authentication failed')
    expect(String(broken?.error)).toContain('Invalid credentials')
    // The healthy mailbox really did authenticate against the local IMAP endpoint.
    expect(fakeImap.loggedIn).toContain('healthy@example.test')
  })

  it('rejects an action that must pick one account and names the accounts', async () => {
    const result: ToolResult = await multiSession.client.callTool({
      name: 'messages',
      arguments: { action: 'read', uid: 1 }
    })

    expect(result.isError).toBe(true)
    const text = resultText(result)
    expect(text).toContain('Account is required')
    expect(text).toContain('healthy@example.test')
    expect(text).toContain('broken@example.test')
  })
})
