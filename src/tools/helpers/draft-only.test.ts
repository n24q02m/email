import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_ONLY_ENV, isDraftOnly, refuseInDraftOnly, restrictTool } from './draft-only.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isDraftOnly', () => {
  it('is off by default', () => {
    vi.stubEnv(DRAFT_ONLY_ENV, '')
    expect(isDraftOnly()).toBe(false)
  })

  it.each(['1', 'true', 'YES', ' 1 '])('is on for %j', (value) => {
    vi.stubEnv(DRAFT_ONLY_ENV, value)
    expect(isDraftOnly()).toBe(true)
  })

  it.each(['0', 'false', 'no'])('is off for %j', (value) => {
    vi.stubEnv(DRAFT_ONLY_ENV, value)
    expect(isDraftOnly()).toBe(false)
  })
})

describe('refuseInDraftOnly', () => {
  it('does nothing when the mode is off', () => {
    vi.stubEnv(DRAFT_ONLY_ENV, '')
    expect(() => refuseInDraftOnly('messages', 'trash')).not.toThrow()
  })

  it('throws a DRAFT_ONLY error for refused actions when the mode is on', () => {
    vi.stubEnv(DRAFT_ONLY_ENV, '1')
    expect(() => refuseInDraftOnly('messages', 'trash')).toThrow(expect.objectContaining({ code: 'DRAFT_ONLY' }))
    expect(() => refuseInDraftOnly('config', 'setup_reset')).toThrow(expect.objectContaining({ code: 'DRAFT_ONLY' }))
  })

  it('lets every other action through', () => {
    vi.stubEnv(DRAFT_ONLY_ENV, '1')
    for (const action of ['search', 'read', 'mark_read', 'flag', 'new', 'reply', 'forward']) {
      expect(() => refuseInDraftOnly('messages', action)).not.toThrow()
    }
    expect(() => refuseInDraftOnly('config', 'status')).not.toThrow()
  })
})

describe('restrictTool', () => {
  const messagesTool = {
    name: 'messages',
    description:
      'Mail.\n\nActions:\n- search (-> account)\n- move (account, uid, destination)\n- archive / trash (account, uid)\n- new (account, to -> cc, draft)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'move', 'archive', 'trash', 'new'] },
        destination: { type: 'string' },
        draft: { type: 'boolean' },
        uid: { type: 'number' }
      }
    }
  }

  it('drops refused actions from the enum, the description and their params', () => {
    const tool = restrictTool(messagesTool)
    expect(tool.inputSchema.properties.action.enum).toEqual(['search', 'new'])
    expect(tool.inputSchema.properties.destination).toBeUndefined()
    expect(tool.inputSchema.properties.draft).toBeUndefined() // every outbound message is a draft anyway
    expect(tool.description).toContain('- new (account, to -> cc)')
    expect(tool.inputSchema.properties.uid).toBeDefined()
    expect(tool.description).toContain('- search (')
    expect(tool.description).toContain('- new (')
    expect(tool.description).not.toMatch(/- (move|archive|trash)/)
    expect(tool.description).toContain('DRAFT-ONLY MODE')
  })

  it('leaves the original definition untouched and other tools as they are', () => {
    restrictTool(messagesTool)
    expect(messagesTool.inputSchema.properties.action.enum).toHaveLength(5)
    const other = { name: 'folders', description: 'x', inputSchema: { properties: {} } }
    expect(restrictTool(other)).toBe(other)
  })
})
