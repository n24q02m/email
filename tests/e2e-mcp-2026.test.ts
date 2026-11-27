/**
 * Real MCP 2026-07-28 E2E tests over BOTH stdio and Streamable HTTP transports.
 *
 * Spawns the built CLI (`bin/cli.mjs` and `bin/cli.mjs --http`) and connects
 * with `@modelcontextprotocol/client` (`Client`, `StdioClientTransport`,
 * `StreamableHTTPClientTransport`, `SkillsClient`) against an in-process fake
 * IMAP endpoint so zero external network calls are needed.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = join(process.cwd(), 'bin', 'cli.mjs')
const TEST_EMAIL = 'e2e@example.test'
const TEST_PASSWORD = 'e2e-app-password'
const ATTACHMENT_TEXT = 'Hello MCP 2026-07-28 attachment payload!'
const SAMPLE_MIME = [
  `From: sender@example.test`,
  `To: ${TEST_EMAIL}`,
  'Subject: Attachment E2E',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUNDARY123"',
  '',
  '--BOUNDARY123',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'Body text',
  '--BOUNDARY123',
  'Content-Type: text/plain; name="hello.txt"',
  'Content-Disposition: attachment; filename="hello.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(ATTACHMENT_TEXT, 'utf8').toString('base64'),
  '--BOUNDARY123--',
  ''
].join('\r\n')

interface FakeImap {
  port: number
  close: () => Promise<void>
}

function startFakeImap(): Promise<FakeImap> {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true)
    socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE] local test IMAP ready\r\n')
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
            reply('* CAPABILITY IMAP4rev1 UIDPLUS MOVE')
            reply(`${tag} OK CAPABILITY completed`)
            break
          case 'LOGIN':
            reply(`${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE] logged in`)
            break
          case 'ID':
            reply('* ID ("name" "email-e2e-2026")')
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
            reply('* LIST (\\Trash \\HasNoChildren) "/" "Trash"')
            reply(`${tag} OK LIST completed`)
            break
          case 'SELECT':
          case 'EXAMINE':
            reply('* 1 EXISTS')
            reply('* 0 RECENT')
            reply('* FLAGS (\\Seen \\Flagged \\Deleted)')
            reply('* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted)] flags')
            reply('* OK [UIDVALIDITY 1] uidvalidity')
            reply('* OK [UIDNEXT 2] uidnext')
            reply(`${tag} OK [READ-WRITE] mailbox selected`)
            break
          case 'UID':
            if (rest.toUpperCase().includes('FETCH')) {
              const rawBytes = Buffer.byteLength(SAMPLE_MIME, 'utf8')
              socket.write(`* 1 FETCH (UID 1 BODY[] {${rawBytes}}\r\n${SAMPLE_MIME})\r\n`)
              reply(`${tag} OK UID FETCH completed`)
            } else {
              reply(`${tag} OK UID completed`)
            }
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

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('fake IMAP failed to bind TCP port'))
        return
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (
      k.startsWith('EMAIL_') ||
      k.startsWith('MCP_AUTH_') ||
      k === 'MCP_TRANSPORT' ||
      k === 'TRANSPORT_MODE' ||
      k === 'PORT' ||
      k === 'MCP_PORT'
    ) {
      continue
    }
    env[k] = v
  }
  return { ...env, ...extra, NODE_ENV: 'test' }
}

async function startHttpChild(env: Record<string, string>): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [CLI, '--http'], {
    env: { ...env, HOST: '127.0.0.1', MCP_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const url = await new Promise<string>((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for HTTP server startup. stderr:\n${stderr}`))
    }, 20_000)

    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`HTTP server exited early with code ${code}. stderr:\n${stderr}`))
    })
  })

  return { child, url }
}

describe('MCP 2026-07-28 E2E (stdio + Streamable HTTP)', { timeout: 60_000 }, () => {
  let fakeImap: FakeImap
  let workDir: string
  let accountsFile: string
  let httpChild: ChildProcess | undefined
  let httpUrl: string

  beforeAll(async () => {
    fakeImap = await startFakeImap()
    workDir = await mkdtemp(join(tmpdir(), 'email-e2e-2026-'))
    accountsFile = join(workDir, 'accounts.toml')
    await writeFile(
      accountsFile,
      `[accounts.main]\nemail = "${TEST_EMAIL}"\npassword = "${TEST_PASSWORD}"\nimap_host = "127.0.0.1"\nimap_port = ${fakeImap.port}\nsmtp_host = "127.0.0.1"\nsmtp_port = 2525\nsmtp_security = "none"\n`,
      'utf8'
    )
    const started = await startHttpChild(
      cleanEnv({ EMAIL_ACCOUNTS_FILE: accountsFile, EMAIL_DATA_DIR: join(workDir, 'http-data') })
    )
    httpChild = started.child
    httpUrl = started.url
  })

  afterAll(async () => {
    if (httpChild && !httpChild.killed) {
      httpChild.kill('SIGTERM')
    }
    await fakeImap.close()
    await rm(workDir, { recursive: true, force: true })
  })

  it('serves skills/list, skill://, elicitation (+ fallback), and files payload over stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      env: cleanEnv({ EMAIL_ACCOUNTS_FILE: accountsFile, EMAIL_DATA_DIR: join(workDir, 'stdio-data') }),
      stderr: 'pipe'
    })
    let elicitationReply: { action: 'accept' | 'decline' | 'cancel'; content?: { confirmed: boolean } } = {
      action: 'decline'
    }
    const elicitClient = new Client(
      { name: 'e2e-stdio-elicit', version: '1.0.0' },
      { capabilities: { elicitation: {} } }
    )
    elicitClient.setRequestHandler('elicitation/create', async () => elicitationReply)

    try {
      await elicitClient.connect(transport)

      // 1. Skills provider (io.modelcontextprotocol/skills)
      const skillsClient = new SkillsClient(elicitClient)
      expect(skillsClient.supported).toBe(true)
      const { skills } = await skillsClient.list()
      expect(skills.map((s) => s.frontmatter.name).sort()).toEqual(['follow-up', 'inbox-review'])
      expect(skills.map((s) => s.uri).sort()).toEqual(['skill://follow-up/SKILL.md', 'skill://inbox-review/SKILL.md'])
      const manifest = await skillsClient.read(skills[0]!)
      expect(manifest.verified).toBe(true)
      expect(manifest.text).toContain(skills[0]!.frontmatter.name)

      const docRes = await elicitClient.readResource({ uri: 'email://docs/messages' })
      expect((docRes.contents[0] as { text?: string }).text).toContain('messages')

      // 2. Elicitation decline & cancel
      elicitationReply = { action: 'decline' }
      const declined = await elicitClient.callTool({
        name: 'messages',
        arguments: { action: 'trash', uid: 1 }
      })
      expect(declined.structuredContent).toMatchObject({ cancelled: true, reason: 'declined', action: 'trash' })

      elicitationReply = { action: 'cancel' }
      const cancelled = await elicitClient.callTool({
        name: 'messages',
        arguments: { action: 'new', to: 'dest@example.test', subject: 'hi', body: 'hello' }
      })
      expect(cancelled.structuredContent).toMatchObject({ cancelled: true, reason: 'cancelled', action: 'new' })

      // 3. Elicitation accept proceeds to handler
      elicitationReply = { action: 'accept', content: { confirmed: true } }
      const confirmedTrash = await elicitClient.callTool({
        name: 'messages',
        arguments: { action: 'trash', uid: 1 }
      })
      expect(confirmedTrash.isError).toBeFalsy()
      expect(confirmedTrash.structuredContent).toMatchObject({ action: 'trash', account: TEST_EMAIL })

      // 4. Attachments io.modelcontextprotocol/files + backward-compatible fields
      const dl = await elicitClient.callTool({
        name: 'attachments',
        arguments: { action: 'download', uid: 1, filename: 'hello.txt' }
      })
      expect(dl.isError).toBeFalsy()
      const dlData = dl.structuredContent as Record<string, unknown>
      expect(dlData.filename).toBe('hello.txt')
      expect(dlData.content_base64).toBe(Buffer.from(ATTACHMENT_TEXT, 'utf8').toString('base64'))
      expect(dlData.file).toMatchObject({
        extension: 'io.modelcontextprotocol/files',
        name: 'hello.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(ATTACHMENT_TEXT, 'utf8'),
        blob: Buffer.from(ATTACHMENT_TEXT, 'utf8').toString('base64')
      })
    } finally {
      await elicitClient.close()
    }

    // 5. Non-eliciting client falls back cleanly without blocking
    const noElicitTransport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      env: cleanEnv({ EMAIL_ACCOUNTS_FILE: accountsFile, EMAIL_DATA_DIR: join(workDir, 'stdio-fallback-data') }),
      stderr: 'pipe'
    })
    const fallbackClient = new Client({ name: 'e2e-stdio-no-elicit', version: '1.0.0' })
    try {
      await fallbackClient.connect(noElicitTransport)
      const fallbackTrash = await fallbackClient.callTool({
        name: 'messages',
        arguments: { action: 'trash', uid: 1 }
      })
      expect(fallbackTrash.isError).toBeFalsy()
      expect(fallbackTrash.structuredContent).toMatchObject({ action: 'trash', account: TEST_EMAIL })
    } finally {
      await fallbackClient.close()
    }
  })

  it('serves skills/list, skill://, elicitation (+ fallback), and files payload over Streamable HTTP', async () => {
    let replyMode: 'decline' | 'accept' = 'decline'
    const client = new Client({ name: 'e2e-http-elicit', version: '1.0.0' }, { capabilities: { elicitation: {} } })
    client.setRequestHandler('elicitation/create', async () =>
      replyMode === 'decline' ? { action: 'decline' } : { action: 'accept', content: { confirmed: true } }
    )
    const transport = new StreamableHTTPClientTransport(new URL(httpUrl))

    try {
      await client.connect(transport)

      const skillsClient = new SkillsClient(client)
      expect(skillsClient.supported).toBe(true)
      const { skills } = await skillsClient.list()
      expect(skills.map((s) => s.frontmatter.name).sort()).toEqual(['follow-up', 'inbox-review'])
      expect(skills.map((s) => s.uri).sort()).toEqual(['skill://follow-up/SKILL.md', 'skill://inbox-review/SKILL.md'])

      const skillDoc = await client.readResource({ uri: 'skill://inbox-review/SKILL.md' })
      expect((skillDoc.contents[0] as { text?: string }).text).toContain('inbox-review')

      const docRes = await client.readResource({ uri: 'email://docs/messages' })
      expect((docRes.contents[0] as { text?: string }).text).toContain('messages')

      replyMode = 'decline'
      const declined = await client.callTool({
        name: 'messages',
        arguments: { action: 'trash', uid: 1 }
      })
      expect(declined.structuredContent).toMatchObject({ cancelled: true, reason: 'declined' })

      replyMode = 'accept'
      const accepted = await client.callTool({
        name: 'messages',
        arguments: { action: 'trash', uid: 1 }
      })
      expect(accepted.isError).toBeFalsy()
      expect(accepted.structuredContent).toMatchObject({ action: 'trash', account: TEST_EMAIL })

      const dl = await client.callTool({
        name: 'attachments',
        arguments: { action: 'download', uid: 1, filename: 'hello.txt' }
      })
      expect(dl.structuredContent).toMatchObject({
        filename: 'hello.txt',
        file: {
          extension: 'io.modelcontextprotocol/files',
          name: 'hello.txt',
          mimeType: 'text/plain'
        }
      })
    } finally {
      await client.close()
    }
  })
})
