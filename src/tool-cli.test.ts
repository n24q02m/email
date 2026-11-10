/**
 * Tool CLI tests.
 *
 * The composite tools are replaced by stub transports (the same seam the
 * registry tests use): each test asserts both that the stub handler ran —
 * proving the CLI dispatches through the shared table rather than its own
 * logic — and that the JSON it printed matches what the handler returned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tools/composite/attachments.js', () => ({ attachments: vi.fn() }))
vi.mock('./tools/composite/config.js', () => ({ handleConfig: vi.fn() }))
vi.mock('./tools/composite/folders.js', () => ({ folders: vi.fn() }))
vi.mock('./tools/composite/messages.js', () => ({ messages: vi.fn(), clearArchiveFolderCache: vi.fn() }))
vi.mock('./tools/helpers/config.js', () => ({ loadConfig: vi.fn() }))

import {
  commandForTool,
  printCliHelp,
  runToolCommand,
  TOOL_COMMANDS,
  toolCliHandlers,
  unmappedTools
} from './tool-cli.js'
import { attachments } from './tools/composite/attachments.js'
import { handleConfig } from './tools/composite/config.js'
import { folders } from './tools/composite/folders.js'
import { messages } from './tools/composite/messages.js'
import { loadConfig } from './tools/helpers/config.js'
import { EmailMCPError } from './tools/helpers/errors.js'
import { TOOLS } from './tools/registry.js'

const ACCOUNTS = [{ email: 'stub@example.com' }]

/** The registry's tool names — the parity source of truth, never a hand list. */
const REGISTERED_TOOLS = TOOLS.map((tool) => tool.name)

let out: string
let err: string

beforeEach(() => {
  out = ''
  err = ''
  // `resolveCredentialState` short-circuits on env credentials, so the tests do
  // not touch the credential files. `loadConfig` is mocked to the account list.
  process.env.EMAIL_CREDENTIALS = 'stub@example.com:secret'
  vi.mocked(loadConfig).mockResolvedValue(ACCOUNTS as never)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    out += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    err += String(chunk)
    return true
  })
})

afterEach(() => {
  delete process.env.EMAIL_CREDENTIALS
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('tool commands reach the shared handlers', () => {
  it('messages search: coerces flags, passes accounts, prints JSON', async () => {
    const payload = { action: 'search', total: 1, messages: [{ uid: 7, subject: 'Hi' }] }
    vi.mocked(messages).mockResolvedValue(payload)

    const code = await runToolCommand('messages', ['search', '--query', 'UNREAD', '--limit', '5', '--json'])

    expect(code).toBe(0)
    expect(messages).toHaveBeenCalledWith(ACCOUNTS, { action: 'search', query: 'UNREAD', limit: 5 })
    expect(JSON.parse(out)).toEqual(payload)
    expect(err).toBe('')
  })

  it('folders list: runs the folders handler', async () => {
    const payload = { action: 'list', folders: [{ path: 'INBOX' }] }
    vi.mocked(folders).mockResolvedValue(payload)

    const code = await runToolCommand('folders', ['list', '--account', 'stub@example.com', '--json'])

    expect(code).toBe(0)
    expect(folders).toHaveBeenCalledWith(ACCOUNTS, { action: 'list', account: 'stub@example.com' })
    expect(JSON.parse(out)).toEqual(payload)
  })

  it('attachments download: coerces uid to a number', async () => {
    const payload = { action: 'download', filename: 'invoice.pdf', size: 12 }
    vi.mocked(attachments).mockResolvedValue(payload)

    const code = await runToolCommand('attachments', [
      'download',
      '--account',
      'stub@example.com',
      '--uid',
      '42',
      '--filename',
      'invoice.pdf',
      '--json'
    ])

    expect(code).toBe(0)
    expect(attachments).toHaveBeenCalledWith(ACCOUNTS, {
      action: 'download',
      account: 'stub@example.com',
      uid: 42,
      filename: 'invoice.pdf'
    })
    expect(JSON.parse(out)).toEqual(payload)
  })

  it('config-tool: runs the config handler without requiring accounts', async () => {
    vi.mocked(loadConfig).mockResolvedValue([])
    const payload = { action: 'cache_clear', ok: true, cleared: 2 }
    vi.mocked(handleConfig).mockResolvedValue(payload as never)

    const code = await runToolCommand('config', ['cache_clear', '--json'])

    expect(code).toBe(0)
    expect(handleConfig).toHaveBeenCalledWith([], { action: 'cache_clear' })
    expect(JSON.parse(out)).toEqual(payload)
  })

  it('help: prints the documentation markdown, or JSON with --json', async () => {
    const human = await runToolCommand('help', ['messages'])
    expect(human).toBe(0)
    expect(out).toContain('# Messages Tool - Full Documentation')

    out = ''
    const json = await runToolCommand('help', ['messages', '--json'])
    expect(json).toBe(0)
    const payload = JSON.parse(out)
    expect(payload.tool).toBe('messages')
    expect(payload.documentation).toContain('# Messages Tool - Full Documentation')
  })

  it('messages mark_read: parses a comma-separated uid list as numbers', async () => {
    vi.mocked(messages).mockResolvedValue({ action: 'mark_read', updated: 2 })

    const code = await runToolCommand('messages', ['mark_read', '--uids', '3,4', '--json'])

    expect(code).toBe(0)
    expect(messages).toHaveBeenCalledWith(ACCOUNTS, { action: 'mark_read', uids: [3, 4] })
  })

  it('messages search: renders human text without --json', async () => {
    vi.mocked(messages).mockResolvedValue({
      action: 'search',
      query: 'UNREAD',
      total: 1,
      messages: [{ uid: 7, subject: 'Hi' }]
    })

    const code = await runToolCommand('messages', ['search'])

    expect(code).toBe(0)
    expect(out).toContain('total: 1')
    expect(out).toContain('uid=7 subject=Hi')
    expect(() => JSON.parse(out)).toThrow()
  })

  it('registers one handler per tool command', async () => {
    vi.mocked(messages).mockResolvedValue({ action: 'search', total: 0, messages: [] })

    const handlers = toolCliHandlers()

    expect(Object.keys(handlers).sort()).toEqual(Object.keys(TOOL_COMMANDS).sort())
    expect(await handlers.messages?.(['search', '--json'])).toBe(0)
    expect(messages).toHaveBeenCalled()
  })
})

describe('CLI parity with the tool registry', () => {
  it('gives every registered tool a CLI command', () => {
    expect(unmappedTools(REGISTERED_TOOLS)).toEqual([])
  })

  it('maps commands only to tools the registry exports', () => {
    const unknown = Object.values(TOOL_COMMANDS).filter((name) => !REGISTERED_TOOLS.includes(name))

    expect(unknown).toEqual([])
  })

  it('resolves the config tool to its published command name, not the operator name', () => {
    expect(commandForTool('config')).toBe('config-tool')
  })

  it('prints the published command name in the config tool usage line', async () => {
    const code = await runToolCommand('config', ['--help'])

    expect(code).toBe(0)
    expect(out).toContain('usage: email config-tool <action> [options]')
  })

  it('fails an unmapped tool by name instead of calling it by its raw name', async () => {
    // A copy of the registry names, so the real TOOLS list stays untouched.
    const synthetic = [...REGISTERED_TOOLS, 'archive']

    expect(unmappedTools(synthetic)).toEqual(['archive'])
    expect(commandForTool('archive')).toBeUndefined()

    const code = await runToolCommand('archive', ['list', '--json'])

    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('Tool archive has no CLI command')
  })
})

describe('failure paths stay on stderr with exit 1', () => {
  it('handler error: prints the error, no stack trace', async () => {
    vi.mocked(messages).mockRejectedValue(new EmailMCPError('IMAP login refused', 'AUTH_ERROR', 'Check the password'))

    const code = await runToolCommand('messages', ['search', '--json'])

    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('Error: IMAP login refused')
    expect(err).toContain('Suggestion: Check the password')
    expect(err).not.toContain('at Object.')
  })

  it('unknown option: names the flag and the valid ones', async () => {
    const code = await runToolCommand('messages', ['search', '--bogus', 'x'])

    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('Unknown option: --bogus')
    expect(err).toContain('--query')
  })

  it('missing required argument: reports the positional', async () => {
    const code = await runToolCommand('attachments', ['--json'])

    expect(code).toBe(1)
    expect(err).toContain('missing required argument <action>')
  })

  it('no credentials: refuses with the same message the MCP guard uses', async () => {
    vi.mocked(loadConfig).mockResolvedValue([])

    const code = await runToolCommand('messages', ['search'])

    expect(code).toBe(1)
    expect(err).toContain('Email credentials are not configured')
    expect(err).toContain('email auth outlook')
  })
})

describe('help output', () => {
  it('per-command help lists the actions and flags from the tool schema', async () => {
    const code = await runToolCommand('messages', ['--help'])

    expect(code).toBe(0)
    expect(out).toContain('usage: email messages <action> [options]')
    expect(out).toContain('mark_read')
    expect(out).toContain('--query <string>')
    expect(out).toContain('Runs the same handler as the `messages` MCP tool.')
  })

  it('prints tool commands apart from operator commands', () => {
    printCliHelp('email')

    expect(out).toContain('tool commands')
    expect(out).toContain('operator commands')
    expect(out.indexOf('tool commands')).toBeLessThan(out.indexOf('operator commands'))
    expect(out).toContain('config-tool <action>')
  })
})
