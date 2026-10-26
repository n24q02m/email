/**
 * Consolidated E2E Tests for email
 *
 * Spawns the actual MCP server via stdio and communicates using JSON-RPC
 * through the official MCP SDK client. Covers all 5 public tools.
 *
 * Three setup modes controlled by E2E_SETUP env var:
 *   - 'env'    (default) : node bin/cli.mjs with EMAIL_CREDENTIALS env var
 *   - 'plugin' :           npx -y @n24q02m/email with EMAIL_CREDENTIALS
 *   - 'http'   :           node bin/cli.mjs with TRANSPORT_MODE=http on loopback (no bearer)
 *
 * Protocol + help tests run without credentials.
 * Email operation tests require EMAIL_CREDENTIALS and skip if not set.
 *
 * Usage:
 *   EMAIL_CREDENTIALS=user@gmail.com:app-pass bun run vitest run tests/e2e.test.ts
 *   E2E_SETUP=plugin EMAIL_CREDENTIALS=... bun run vitest run tests/e2e.test.ts
 *   E2E_SETUP=http bun run vitest run tests/e2e.test.ts
 */

import type { ChildProcess } from 'node:child_process'
import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** Resolve npx command for plugin mode (Windows .mjs bin workaround) */
function pluginCommand(pkg: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const binName = pkg.split('/').pop()!
    try {
      execSync(`npx -y ${pkg} --help`, { stdio: 'ignore', timeout: 30_000 })
    } catch {
      /* install */
    }
    const npxCache = `${process.env.LOCALAPPDATA ?? ''}/npm-cache/_npx`
    try {
      const cacheHit = execSync(`find "${npxCache}" -path "*/${binName}/bin/cli.mjs" -print -quit`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (cacheHit) return { command: process.execPath, args: [cacheHit] }
    } catch {
      /* find missing or failed */
    }
  }
  return { command: 'npx', args: ['-y', pkg] }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const E2E_SETUP = (process.env.E2E_SETUP ?? 'env') as 'env' | 'plugin' | 'http'
const EMAIL_CREDS = process.env.EMAIL_CREDENTIALS ?? ''
// The stdio entry point requires credentials before it accepts MCP initialize.
// Keep the default protocol-only E2E deterministic without enabling email tests.
const OFFLINE_TEST_CREDENTIALS = 'test@gmail.com:fake_password'
/** Credentials available via env var */
const HAS_CREDS = !!EMAIL_CREDS
// Mutable: set from env var initially, updated by probe if saved tokens provide it
let TEST_ACCOUNT = EMAIL_CREDS.split(',')[0]?.split(':')[0] ?? ''

const EXPECTED_TOOLS = ['messages', 'folders', 'attachments', 'config', 'help'] as const
const EXPECTED_HELP_TOPICS = ['messages', 'folders', 'attachments', 'config', 'help'] as const
const _EMAIL_DEPENDENT_TOOLS = ['messages', 'folders', 'attachments'] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract JSON object from the MCP tool result text (server wraps with header/footer) */
function parseResult(result: any): any {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`No JSON in response: ${text}`)
  return JSON.parse(jsonMatch[0])
}

/** Wait for email delivery propagation */
function waitForDelivery(ms = 5000): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Generate unique test subject to avoid collision between runs */
function testSubject(label = ''): string {
  const suffix = label ? `-${label}` : ''
  return `[MCP-TEST-${Date.now()}${suffix}]`
}

// ---------------------------------------------------------------------------
// Transport factory (stdio modes only -- http mode handled separately in beforeAll)
// ---------------------------------------------------------------------------

function createStdioTransport(): StdioClientTransport {
  switch (E2E_SETUP) {
    case 'plugin':
      return new StdioClientTransport({
        ...pluginCommand('@n24q02m/email'),
        env: {
          ...process.env,
          EMAIL_CREDENTIALS: EMAIL_CREDS,
          NODE_ENV: 'test'
        },
        stderr: 'pipe'
      })
    default:
      return new StdioClientTransport({
        command: 'node',
        args: ['bin/cli.mjs'],
        env: {
          ...process.env,
          EMAIL_CREDENTIALS: EMAIL_CREDS || OFFLINE_TEST_CREDENTIALS,
          NODE_ENV: 'test'
        },
        stderr: 'pipe'
      })
  }
}

// ---------------------------------------------------------------------------
// HTTP mode constants
// ---------------------------------------------------------------------------

const HTTP_E2E_PORT = 18080
const HTTP_E2E_URL = `http://127.0.0.1:${HTTP_E2E_PORT}`

// ---------------------------------------------------------------------------
// Single shared client for the entire test suite
// ---------------------------------------------------------------------------

let client: Client
let transport: StdioClientTransport | StreamableHTTPClientTransport
let httpServerProcess: ChildProcess | undefined

// Track all test email UIDs for cleanup in afterAll
const testUids: number[] = []

beforeAll(async () => {
  client = new Client({ name: 'e2e-test', version: '1.0.0' })

  if (E2E_SETUP === 'http') {
    // --- HTTP mode: spawn loopback HTTP server, StreamableHTTPClientTransport ---
    const { spawn } = await import('node:child_process')
    httpServerProcess = spawn('node', ['bin/cli.mjs'], {
      env: {
        ...process.env,
        TRANSPORT_MODE: 'http',
        HOST: '127.0.0.1',
        EMAIL_MCP_TOKEN_HASH: '',
        PORT: String(HTTP_E2E_PORT),
        NODE_ENV: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd()
    })

    // Capture stderr for debugging
    httpServerProcess.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) console.error(`[http-server] ${line}`)
    })

    // Wait for /health to be ready
    const deadline = Date.now() + 15_000
    let serverReady = false
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${HTTP_E2E_URL}/health`)
        if (res.ok) {
          serverReady = true
          break
        }
      } catch {
        /* not ready yet */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!serverReady) throw new Error('HTTP server did not become healthy within 15s')

    // Loopback server runs with no bearer token (EMAIL_MCP_TOKEN_HASH unset)
    transport = new StreamableHTTPClientTransport(new URL(`${HTTP_E2E_URL}/mcp`))

    await client.connect(transport)
    console.error('HTTP mode: MCP client connected via StreamableHTTPClientTransport')
  } else {
    // --- env / plugin mode: stdio with EMAIL_CREDENTIALS ---
    transport = createStdioTransport()
    await client.connect(transport)
  }

  // Probe: if TEST_ACCOUNT is empty (http/saved tokens), detect from folders.list
  if (!TEST_ACCOUNT && HAS_CREDS) {
    try {
      const probe = await client.callTool({ name: 'folders', arguments: { action: 'list' } })
      const text = (probe.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
      const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/)
      if (emailMatch) {
        TEST_ACCOUNT = emailMatch[0]
        console.error(`Detected account from server: ${TEST_ACCOUNT}`)
      }
    } catch {
      // Probe failed -- TEST_ACCOUNT remains empty
    }
  }
}, 180_000) // 3 min budget for spawned server startup

afterAll(async () => {
  // Best-effort cleanup: trash all test emails
  if (testUids.length > 0 && TEST_ACCOUNT) {
    try {
      await client.callTool({
        name: 'messages',
        arguments: {
          action: 'trash',
          account: TEST_ACCOUNT,
          uids: testUids
        }
      })
    } catch {
      // Best-effort
    }
  }
  await transport.close()

  // Kill HTTP server process if running
  if (httpServerProcess) {
    httpServerProcess.kill()
    httpServerProcess = undefined
  }
})

// ===========================================================================
// 1. Server initialization (no credentials needed)
// ===========================================================================

describe('Server initialization', () => {
  it('should connect and report server info', () => {
    const info = client.getServerVersion()
    expect(info).toBeDefined()
    expect(info?.name).toBe('email')
    expect(info?.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('should report tools capability', () => {
    const caps = client.getServerCapabilities()
    expect(caps).toBeDefined()
    expect(caps?.tools).toBeDefined()
  })

  it('should report resources capability', () => {
    const caps = client.getServerCapabilities()
    expect(caps?.resources).toBeDefined()
  })
})

// ===========================================================================
// 2. tools/list (no credentials needed)
// ===========================================================================

describe('tools/list', () => {
  it('should return exactly the 5 public tools', async () => {
    const result = await client.listTools()
    const names = result.tools.map((t) => t.name)
    expect(names).toEqual(EXPECTED_TOOLS)
  })

  it('should have valid inputSchema for each tool', async () => {
    const result = await client.listTools()
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description).toBeTruthy()
    }
  })

  it('should have annotations on each tool', async () => {
    const result = await client.listTools()
    for (const tool of result.tools) {
      expect(tool.annotations).toBeDefined()
      expect(tool.annotations?.title).toBeTruthy()
    }
  })
})

// ===========================================================================
// 3. help tool (no credentials needed)
// ===========================================================================

describe('help', () => {
  for (const toolName of EXPECTED_HELP_TOPICS) {
    it(`should return documentation for ${toolName}`, async () => {
      const result = await client.callTool({
        name: 'help',
        arguments: { tool_name: toolName }
      })
      expect(result.isError).toBeFalsy()
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
      expect(text).toBeTruthy()
      expect(text).toContain(toolName)
    })
  }

  it('should return error for invalid tool name', async () => {
    const result = await client.callTool({
      name: 'help',
      arguments: { tool_name: 'nonexistent' }
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
    expect(text).toContain('Invalid tool name')
  })
})

// ===========================================================================
// 4. folders (requires EMAIL_CREDENTIALS)
// ===========================================================================

describe.skipIf(!HAS_CREDS)('folders', () => {
  it('folders.list -- should list folders and include INBOX', async () => {
    const result = await client.callTool({
      name: 'folders',
      arguments: { action: 'list', account: TEST_ACCOUNT }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('list')
    expect(data.total_accounts).toBeGreaterThanOrEqual(1)

    const accountFolders = data.accounts[0]
    expect(accountFolders.account_email).toBe(TEST_ACCOUNT)
    expect(accountFolders.folders.length).toBeGreaterThan(0)

    const folderPaths = accountFolders.folders.map((f: any) => f.path)
    expect(folderPaths).toContain('INBOX')
  }, 30_000)
})

// ===========================================================================
// 5. messages -- outbound + lifecycle (requires EMAIL_CREDENTIALS)
// ===========================================================================

describe.skipIf(!HAS_CREDS)('messages -- outbound + lifecycle', () => {
  const LIFECYCLE_SUBJECT = testSubject('LIFECYCLE')
  let sentUid: number

  // 5.1 messages.new
  it('messages.new -- send email to self', async () => {
    const result = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'new',
        account: TEST_ACCOUNT,
        to: TEST_ACCOUNT,
        subject: LIFECYCLE_SUBJECT,
        body: `Test body for ${LIFECYCLE_SUBJECT}`
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('new')
    expect(data.success).toBe(true)
    expect(data.from).toBe(TEST_ACCOUNT)
    expect(data.to).toBe(TEST_ACCOUNT)
    expect(data.subject).toBe(LIFECYCLE_SUBJECT)
    expect(data.message_id).toBeTruthy()
  }, 30_000)

  // 5.2 messages.search
  it('messages.search -- find the sent email by subject', async () => {
    await waitForDelivery(5000)

    const result = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${LIFECYCLE_SUBJECT}"`,
        folder: 'INBOX',
        limit: 5
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('search')
    expect(data.total).toBeGreaterThanOrEqual(1)

    const found = data.messages.find((m: any) => m.subject?.includes('[MCP-TEST-'))
    expect(found).toBeDefined()
    sentUid = found.uid
    testUids.push(sentUid)
  }, 60_000)

  // 5.3 messages.read
  it('messages.read -- read the email and verify body', async () => {
    expect(sentUid).toBeDefined()

    const result = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'read',
        account: TEST_ACCOUNT,
        uid: sentUid
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('read')
    expect(data.subject).toContain('[MCP-TEST-')
    expect(data.body_text).toContain('Test body for')
  }, 30_000)

  // 5.4 messages.mark_read
  it('messages.mark_read -- mark as read', async () => {
    expect(sentUid).toBeDefined()

    const result = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'mark_read',
        account: TEST_ACCOUNT,
        uid: sentUid
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('mark_read')
    expect(data.account).toBe(TEST_ACCOUNT)
  }, 30_000)

  // 5.5 messages.mark_unread
  it('messages.mark_unread -- mark as unread', async () => {
    expect(sentUid).toBeDefined()

    const result = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'mark_unread',
        account: TEST_ACCOUNT,
        uid: sentUid
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('mark_unread')
    expect(data.account).toBe(TEST_ACCOUNT)
  }, 30_000)

  // 5.6 messages.flag
  it('messages.flag -- flag the message', async () => {
    expect(sentUid).toBeDefined()

    const result = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'flag',
        account: TEST_ACCOUNT,
        uid: sentUid
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('flag')
    expect(data.account).toBe(TEST_ACCOUNT)
  }, 30_000)

  // 5.7 messages.unflag
  it('messages.unflag -- unflag the message', async () => {
    expect(sentUid).toBeDefined()

    const result = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'unflag',
        account: TEST_ACCOUNT,
        uid: sentUid
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('unflag')
    expect(data.account).toBe(TEST_ACCOUNT)
  }, 30_000)

  // 5.8 messages.move
  it('messages.move -- move to a different folder and verify', async () => {
    expect(sentUid).toBeDefined()

    // Detect available folders to pick a valid destination
    const foldersResult = await client.callTool({
      name: 'folders',
      arguments: { action: 'list', account: TEST_ACCOUNT }
    })
    const foldersData = parseResult(foldersResult)
    const folderPaths: string[] = (foldersData.accounts?.[0]?.folders ?? []).map((f: any) => f.path)

    // Pick destination: prefer Drafts (works on all providers)
    const destination =
      folderPaths.find((f: string) => /drafts/i.test(f)) ?? folderPaths.find((f: string) => f !== 'INBOX') ?? 'Drafts'

    const moveResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'move',
        account: TEST_ACCOUNT,
        uid: sentUid,
        folder: 'INBOX',
        destination
      }
    })

    expect(moveResult.isError).toBeFalsy()
    const moveData = parseResult(moveResult)
    expect(moveData.action).toBe('move')
    expect(moveData.from_folder).toBe('INBOX')
    expect(moveData.account).toBe(TEST_ACCOUNT)

    // After move, UID may change. Remove old UID from cleanup.
    const idx = testUids.indexOf(sentUid)
    if (idx >= 0) testUids.splice(idx, 1)

    // Search in destination folder for cleanup
    await waitForDelivery(2000)
    const searchResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${LIFECYCLE_SUBJECT}"`,
        folder: destination,
        limit: 5
      }
    })
    if (!searchResult.isError) {
      const searchData = parseResult(searchResult)
      const found = searchData.messages?.find((m: any) => m.subject?.includes('[MCP-TEST-'))
      if (found) {
        sentUid = found.uid
        await client.callTool({
          name: 'messages',
          arguments: { action: 'trash', account: TEST_ACCOUNT, uid: sentUid, folder: destination }
        })
      }
    }
  }, 60_000)

  // 5.9 messages.archive
  it('messages.archive -- archive a message', async () => {
    const archiveSubject = testSubject('ARCHIVE')

    // Send a fresh email
    const sendResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'new',
        account: TEST_ACCOUNT,
        to: TEST_ACCOUNT,
        subject: archiveSubject,
        body: 'Email for archive test'
      }
    })
    expect(sendResult.isError).toBeFalsy()

    await waitForDelivery(5000)

    // Find the email
    const searchResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${archiveSubject}"`,
        folder: 'INBOX',
        limit: 5
      }
    })
    const searchData = parseResult(searchResult)
    const found = searchData.messages.find((m: any) => m.subject?.includes('MCP-TEST-'))
    expect(found).toBeDefined()

    const archiveUid = found.uid

    // Archive it
    const archiveResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'archive',
        account: TEST_ACCOUNT,
        uid: archiveUid
      }
    })

    expect(archiveResult.isError).toBeFalsy()
    const archiveData = parseResult(archiveResult)
    expect(archiveData.action).toBe('archive')
    expect(archiveData.account).toBe(TEST_ACCOUNT)
    expect(archiveData.from_folder).toBe('INBOX')
    // archive_folder varies by provider ([Gmail]/All Mail, Archive, etc.)
    expect(archiveData.archive_folder).toBeTruthy()

    // Cleanup: find in archive folder and trash
    await waitForDelivery(2000)
    try {
      const cleanupSearch = await client.callTool({
        name: 'messages',
        arguments: {
          action: 'search',
          account: TEST_ACCOUNT,
          query: `SUBJECT "${archiveSubject}"`,
          folder: archiveData.archive_folder,
          limit: 5
        }
      })
      const cleanupData = parseResult(cleanupSearch)
      for (const msg of cleanupData.messages) {
        if (msg.subject?.includes('MCP-TEST-')) {
          await client.callTool({
            name: 'messages',
            arguments: {
              action: 'trash',
              account: TEST_ACCOUNT,
              uid: msg.uid,
              folder: archiveData.archive_folder
            }
          })
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }, 60_000)

  // 5.10 messages.trash
  it('messages.trash -- send a fresh email and trash it', async () => {
    const trashSubject = testSubject('TRASH')

    await client.callTool({
      name: 'messages',
      arguments: {
        action: 'new',
        account: TEST_ACCOUNT,
        to: TEST_ACCOUNT,
        subject: trashSubject,
        body: 'Email to be trashed'
      }
    })

    await waitForDelivery(5000)

    const searchResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${trashSubject}"`,
        folder: 'INBOX',
        limit: 5
      }
    })
    const searchData = parseResult(searchResult)
    const trashMsg = searchData.messages.find((m: any) => m.subject?.includes('MCP-TEST-'))
    expect(trashMsg).toBeDefined()

    const result = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'trash',
        account: TEST_ACCOUNT,
        uid: trashMsg.uid
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('trash')
    expect(data.account).toBe(TEST_ACCOUNT)
  }, 60_000)
})

// ===========================================================================
// 6. messages.reply (requires EMAIL_CREDENTIALS)
// ===========================================================================

describe.skipIf(!HAS_CREDS)('messages.reply', () => {
  const replySubject = testSubject('REPLY')
  let originalUid: number

  it('should send original, find it, reply, and verify Re: prefix', async () => {
    // Step 1: Send original
    const sendResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'new',
        account: TEST_ACCOUNT,
        to: TEST_ACCOUNT,
        subject: replySubject,
        body: 'Original message for reply test'
      }
    })
    expect(sendResult.isError).toBeFalsy()

    await waitForDelivery(5000)

    // Step 2: Find the email
    const searchResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${replySubject}"`,
        folder: 'INBOX',
        limit: 5
      }
    })
    const searchData = parseResult(searchResult)
    const found = searchData.messages.find((m: any) => m.subject?.includes('MCP-TEST-'))
    expect(found).toBeDefined()
    originalUid = found.uid
    testUids.push(originalUid)

    // Step 3: Reply to it
    const replyResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'reply',
        account: TEST_ACCOUNT,
        uid: originalUid,
        body: 'This is a reply to the test email'
      }
    })
    expect(replyResult.isError).toBeFalsy()
    const replyData = parseResult(replyResult)
    expect(replyData.action).toBe('reply')
    expect(replyData.success).toBe(true)
    expect(replyData.subject).toContain('Re:')
    expect(replyData.in_reply_to).toBeTruthy()

    // Cleanup: collect reply UIDs
    await waitForDelivery(3000)
    const cleanupSearch = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${replySubject}"`,
        folder: 'INBOX',
        limit: 10
      }
    })
    const cleanupData = parseResult(cleanupSearch)
    for (const msg of cleanupData.messages) {
      if (msg.subject?.includes('MCP-TEST-') && !testUids.includes(msg.uid)) {
        testUids.push(msg.uid)
      }
    }
  }, 60_000)
})

// ===========================================================================
// 7. messages.forward (requires EMAIL_CREDENTIALS)
// ===========================================================================

describe.skipIf(!HAS_CREDS)('messages.forward', () => {
  const fwdSubject = testSubject('FWD')
  let originalUid: number

  it('should send original, find it, forward, and verify Fwd: prefix', async () => {
    // Step 1: Send original
    const sendResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'new',
        account: TEST_ACCOUNT,
        to: TEST_ACCOUNT,
        subject: fwdSubject,
        body: 'Original message for forward test'
      }
    })
    expect(sendResult.isError).toBeFalsy()

    await waitForDelivery(5000)

    // Step 2: Find the email
    const searchResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${fwdSubject}"`,
        folder: 'INBOX',
        limit: 5
      }
    })
    const searchData = parseResult(searchResult)
    const found = searchData.messages.find((m: any) => m.subject?.includes('MCP-TEST-'))
    expect(found).toBeDefined()
    originalUid = found.uid
    testUids.push(originalUid)

    // Step 3: Forward to self
    const fwdResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'forward',
        account: TEST_ACCOUNT,
        uid: originalUid,
        to: TEST_ACCOUNT,
        body: 'Forwarding this email to you'
      }
    })
    expect(fwdResult.isError).toBeFalsy()
    const fwdData = parseResult(fwdResult)
    expect(fwdData.action).toBe('forward')
    expect(fwdData.success).toBe(true)
    expect(fwdData.subject).toContain('Fwd:')

    // Cleanup: collect forwarded UIDs
    await waitForDelivery(3000)
    const cleanupSearch = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${fwdSubject}"`,
        folder: 'INBOX',
        limit: 10
      }
    })
    const cleanupData = parseResult(cleanupSearch)
    for (const msg of cleanupData.messages) {
      if (msg.subject?.includes('MCP-TEST-') && !testUids.includes(msg.uid)) {
        testUids.push(msg.uid)
      }
    }
  }, 60_000)
})

// ===========================================================================
// 8. attachments (requires EMAIL_CREDENTIALS)
// ===========================================================================

describe.skipIf(!HAS_CREDS)('attachments', () => {
  const attSubject = testSubject('ATT')
  let emailUid: number

  it('attachments.list -- list attachments on a text email (0 expected)', async () => {
    // Send an email to self (no attachment support in messages tool)
    const sendResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'new',
        account: TEST_ACCOUNT,
        to: TEST_ACCOUNT,
        subject: attSubject,
        body: 'Email for attachment list test'
      }
    })
    expect(sendResult.isError).toBeFalsy()

    await waitForDelivery(5000)

    // Find the email
    const searchResult = await client.callTool({
      name: 'messages',
      arguments: {
        action: 'search',
        account: TEST_ACCOUNT,
        query: `SUBJECT "${attSubject}"`,
        folder: 'INBOX',
        limit: 5
      }
    })
    const searchData = parseResult(searchResult)
    const found = searchData.messages.find((m: any) => m.subject?.includes('MCP-TEST-'))
    expect(found).toBeDefined()
    emailUid = found.uid
    testUids.push(emailUid)

    // List attachments
    const result = await client.callTool({
      name: 'attachments',
      arguments: {
        action: 'list',
        account: TEST_ACCOUNT,
        uid: emailUid
      }
    })

    expect(result.isError).toBeFalsy()
    const data = parseResult(result)
    expect(data.action).toBe('list')
    expect(data.account).toBe(TEST_ACCOUNT)
    expect(data.uid).toBe(emailUid)
    expect(data.total).toBe(0)
    expect(data.attachments).toEqual([])
  }, 60_000)

  it('attachments.download -- should error when no filename provided', async () => {
    expect(emailUid).toBeDefined()

    const result = await client.callTool({
      name: 'attachments',
      arguments: {
        action: 'download',
        account: TEST_ACCOUNT,
        uid: emailUid
        // No filename -- should error
      }
    })

    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
    expect(text).toContain('filename')
  }, 30_000)
})

// ===========================================================================
// 9. error handling (no credentials needed for most, mixed)
// ===========================================================================

describe('error handling', () => {
  it('should return error for unknown tool', async () => {
    const result = await client.callTool({
      name: 'nonexistent_tool',
      arguments: { action: 'test' }
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
    expect(text).toContain('Unknown tool')
  })

  it('should return error when no arguments provided', async () => {
    const result = await client.callTool({
      name: 'messages',
      arguments: undefined as any
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
    expect(text).toContain('No arguments provided')
  })

  // No-accounts hint: only meaningful when the server truly has zero accounts.
  // The server may auto-load credentials from saved OAuth tokens.
  // even without EMAIL_CREDENTIALS env var. We skip these tests when credentials
  // are set, AND test with a fake account that will never match.
  describe.skipIf(HAS_CREDS)('no-accounts hints', () => {
    it('messages should return error when no accounts exist or account not found', async () => {
      const result = await client.callTool({
        name: 'messages',
        arguments: { action: 'search', account: 'nonexistent-e2e@example.invalid' }
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
      expect(text).toBeTruthy()
      // Server returns either "No email accounts configured" (zero accounts)
      // or "Account not found" (has accounts but this one doesn't match)
      expect(
        text.includes('No email accounts') ||
          text.includes('Account not found') ||
          text.includes('Email credentials are not configured yet')
      ).toBe(true)
    })

    it('folders should return error when no accounts exist or account not found', async () => {
      const result = await client.callTool({
        name: 'folders',
        arguments: { action: 'list', account: 'nonexistent-e2e@example.invalid' }
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
      expect(text).toBeTruthy()
      expect(
        text.includes('No email accounts') ||
          text.includes('Account not found') ||
          text.includes('Email credentials are not configured yet')
      ).toBe(true)
    })

    it('attachments should return error when no accounts exist or account not found', async () => {
      const result = await client.callTool({
        name: 'attachments',
        arguments: { action: 'list', account: 'nonexistent-e2e@example.invalid', uid: 1 }
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
      expect(text).toBeTruthy()
      expect(
        text.includes('No email accounts') ||
          text.includes('Account not found') ||
          text.includes('Email credentials are not configured yet')
      ).toBe(true)
    })

    it('messages.new should return error when no accounts exist or account not found', async () => {
      const result = await client.callTool({
        name: 'messages',
        arguments: {
          action: 'new',
          account: 'nonexistent-e2e@example.invalid',
          to: 'a@b.com',
          subject: 'test',
          body: 'test'
        }
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
      expect(text).toBeTruthy()
      expect(
        text.includes('No email accounts') ||
          text.includes('Account not found') ||
          text.includes('Email credentials are not configured yet')
      ).toBe(true)
    })
  })

  it.skipIf(!HAS_CREDS)(
    'should reject operations for unconfigured account',
    async () => {
      const result = await client.callTool({
        name: 'messages',
        arguments: {
          action: 'search',
          account: 'nonexistent@example.com'
        }
      })

      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
      expect(text).toBeTruthy()
    },
    30_000
  )
})

// ===========================================================================
// 10. connection stability (no credentials needed)
// ===========================================================================

describe('connection stability', () => {
  it('should respond to ping', async () => {
    const result = await client.ping()
    expect(result).toBeDefined()
  })

  it('should handle rapid sequential calls without failure', async () => {
    // Fire 5 rapid help calls to verify stability under load
    const results = await Promise.all(
      EXPECTED_HELP_TOPICS.map((toolName) => client.callTool({ name: 'help', arguments: { tool_name: toolName } }))
    )

    for (const result of results) {
      expect(result.isError).toBeFalsy()
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text
      expect(text).toBeTruthy()
    }
  }, 30_000)

  it('should respond to ping after rapid calls', async () => {
    const result = await client.ping()
    expect(result).toBeDefined()
  })
})

// ===========================================================================
// 11. HTTP Transport — Local Server
// Skip when E2E_SETUP=http because the main transport already occupies port 18080
// ===========================================================================

describe.skipIf(E2E_SETUP === 'http')('HTTP Transport — Local Server', () => {
  const HTTP_PORT = 18080
  const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}`
  let httpProcess: any // ChildProcess

  beforeAll(async () => {
    const { spawn } = await import('node:child_process')
    httpProcess = spawn('node', ['bin/cli.mjs'], {
      env: {
        ...process.env,
        TRANSPORT_MODE: 'http',
        HOST: '127.0.0.1',
        EMAIL_MCP_TOKEN_HASH: '',
        PORT: String(HTTP_PORT),
        NODE_ENV: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd()
    })

    // Wait for server ready
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${HTTP_URL}/health`)
        if (res.ok) break
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }, 20_000)

  afterAll(() => {
    httpProcess?.kill()
  })

  describe('Health endpoint', () => {
    it('GET /health should return ok', async () => {
      const res = await fetch(`${HTTP_URL}/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
    })
  })
})
