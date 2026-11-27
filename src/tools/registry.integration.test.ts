import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies before importing registry
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn()
}))

vi.mock('./helpers/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpers/security.js')>()
  return {
    ...actual,
    isValidToolName: vi.fn((name) => {
      // Force "unknown_but_valid" to be treated as a valid tool,
      // which allows it to pass validation but fail the RESOURCES lookup.
      if (name === 'unknown_but_valid') return true
      return actual.isValidToolName(name)
    })
  }
})

// Import after mocking
import { registerTools } from './registry.js'

describe('registry.ts - help tool error handling', () => {
  let mockServer: any
  let callToolHandler: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockServer = {
      setRequestHandler: vi.fn((schema, handler) => {
        if (schema === 'tools/call') {
          callToolHandler = handler
        }
      })
    }
  })

  it('should return a validation error for invalid tool names', async () => {
    // 1. Register tools
    registerTools(mockServer, [])

    // 2. Ensure handler was registered
    expect(callToolHandler).toBeDefined()

    // 3. Call the handler with an invalid tool name (blocked by isValidToolName)
    const result = await callToolHandler({
      params: {
        name: 'help',
        arguments: { tool_name: 'nonexistent-tool' }
      }
    })

    // 4. Verify the validation error response
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Invalid tool name: nonexistent-tool')
  })

  it('should return a friendly error when documentation file is missing', async () => {
    // 1. Register tools
    registerTools(mockServer, [])

    // 2. Ensure handler was registered
    expect(callToolHandler).toBeDefined()

    // 3. Mock readFile to reject (simulating missing file) for a valid tool name
    vi.mocked(readFile).mockRejectedValue(new Error('File not found'))

    // 4. Call the handler with a valid tool name but missing docs file
    const result = await callToolHandler({
      params: {
        name: 'help',
        arguments: { tool_name: 'messages' }
      }
    })

    // 5. Verify the error response
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Documentation not found for: messages')
  })
})

describe('registry.ts - ReadResource success', () => {
  let mockServer: any
  let readResourceHandler: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockServer = {
      setRequestHandler: vi.fn((schema, handler) => {
        if (schema === 'resources/read') {
          readResourceHandler = handler
        }
      })
    }
  })

  it('should return markdown content for a valid resource URI', async () => {
    registerTools(mockServer, [])
    expect(readResourceHandler).toBeDefined()

    const docContent = '# Messages Tool\n\nFull documentation here.'
    vi.mocked(readFile).mockResolvedValue(docContent)

    const result = await readResourceHandler({
      params: { uri: 'email://docs/messages' }
    })

    expect(result).toEqual({
      contents: [
        {
          uri: 'email://docs/messages',
          mimeType: 'text/markdown',
          text: docContent
        }
      ]
    })
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('messages.md'), 'utf-8')
  })
})

describe('registry.ts - help tool success', () => {
  let mockServer: any
  let callToolHandler: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockServer = {
      setRequestHandler: vi.fn((schema, handler) => {
        if (schema === 'tools/call') {
          callToolHandler = handler
        }
      })
    }
  })

  it('should return documentation content for a valid tool name', async () => {
    registerTools(mockServer, [])
    expect(callToolHandler).toBeDefined()

    const docContent = '# Messages\n\nSearch, read, and manage emails.'
    vi.mocked(readFile).mockResolvedValue(docContent)

    const result = await callToolHandler({
      params: {
        name: 'help',
        arguments: { tool_name: 'messages' }
      }
    })

    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.tool).toBe('messages')
    expect(parsed.documentation).toBe(docContent)

    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('messages.md'), 'utf-8')
  })
})

describe('registry.ts - help tool error handling edge case', () => {
  let mockServer: any
  let callToolHandler: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockServer = {
      setRequestHandler: vi.fn((schema, handler) => {
        if (schema === 'tools/call') {
          callToolHandler = handler
        }
      })
    }
  })

  it('should return DOC_NOT_FOUND when tool name is valid but missing from RESOURCES', async () => {
    // 1. Register tools
    registerTools(mockServer, [])

    // 2. Ensure handler was registered
    expect(callToolHandler).toBeDefined()

    // 3. Call the handler with an "unknown_but_valid" tool name
    // (Our mock makes this pass isValidToolName, but it won't be in RESOURCES)
    const result = await callToolHandler({
      params: {
        name: 'help',
        arguments: { tool_name: 'unknown_but_valid' }
      }
    })

    // 4. Verify the correct DOC_NOT_FOUND error response
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Documentation not found for: unknown_but_valid')
    // DOC_NOT_FOUND code itself isn't in the aiReadableMessage output, but the error message is.
  })
})

describe('registry.ts - core registration', () => {
  let mockServer: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockServer = {
      setRequestHandler: vi.fn()
    }
  })

  it('should register tools/list and resources/list', async () => {
    registerTools(mockServer, [])

    const listToolsCall = mockServer.setRequestHandler.mock.calls.find((call: any[]) => call[0] === 'tools/list')
    expect(listToolsCall).toBeDefined()
    expect(listToolsCall[1]).toBeTypeOf('function')

    // Invoke the registered handler
    const listToolsResult = await listToolsCall[1]({})
    expect(listToolsResult).toHaveProperty('tools')
    expect(Array.isArray(listToolsResult.tools)).toBe(true)
    expect(listToolsResult.tools.length).toBeGreaterThan(0)
    expect(listToolsResult.tools[0]).toHaveProperty('name')
    expect(listToolsResult.tools[0]).toHaveProperty('description')

    const listResourcesCall = mockServer.setRequestHandler.mock.calls.find(
      (call: any[]) => call[0] === 'resources/list'
    )
    expect(listResourcesCall).toBeDefined()
    expect(listResourcesCall[1]).toBeTypeOf('function')

    // Invoke the registered handler
    const listResourcesResult = await listResourcesCall[1]({})
    expect(listResourcesResult).toHaveProperty('resources')
    expect(Array.isArray(listResourcesResult.resources)).toBe(true)
    expect(listResourcesResult.resources.length).toBeGreaterThan(0)
    expect(listResourcesResult.resources[0]).toHaveProperty('uri')
    expect(listResourcesResult.resources[0]).toHaveProperty('name')
  })

  it('registers doc resources via McpServer.registerResource and handles elicitation outcomes', async () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const registeredResources: Array<{ name: string; uri: string; read: () => Promise<any> }> = []
    const mcpLikeServer = {
      registerResource: vi.fn((name: string, uri: string, _cfg: unknown, read: () => Promise<any>) => {
        registeredResources.push({ name, uri, read })
      }),
      server: {
        setRequestHandler: vi.fn((method: string, handler: (...args: any[]) => any) => {
          handlers.set(method, handler)
        })
      }
    }
    vi.mocked(readFile).mockResolvedValue('# Doc content')

    registerTools(mcpLikeServer as any, [{ email: 'user@example.com' }] as any)
    expect(registeredResources).toHaveLength(5)
    expect(handlers.has('resources/list')).toBe(false)
    const firstRead = await registeredResources[0].read()
    expect(firstRead.contents[0].text).toBe('# Doc content')

    const callTool = handlers.get('tools/call')!
    // Envelope without elicitation capability falls back cleanly when client rejects push/MRTR
    const challengeCtx = {
      mcpReq: {
        id: 1,
        method: 'tools/call',
        envelope: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
      }
    }
    const mrtrResult = await callTool(
      { params: { name: 'messages', arguments: { action: 'trash', uid: 42 } } },
      challengeCtx
    )
    expect(mrtrResult.resultType).toBe('input_required')

    const declinedCtx = {
      mcpReq: {
        id: 2,
        method: 'tools/call',
        inputResponses: { confirm_trash_email: { action: 'decline' } }
      }
    }
    const declinedResult = await callTool(
      { params: { name: 'messages', arguments: { action: 'trash', uid: 42 } } },
      declinedCtx
    )
    expect(declinedResult.structuredContent).toMatchObject({ cancelled: true, reason: 'declined', action: 'trash' })
  })
})
