import type { ServerContext } from '@modelcontextprotocol/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const elicitWithFallbackMock = vi.hoisted(() => vi.fn())

vi.mock('@n24q02m/hull', () => ({
  elicitWithFallback: elicitWithFallbackMock
}))

import { confirmSensitiveOperation, describeSensitiveOperation } from './elicitation.js'

function mockContext(overrides: Record<string, unknown> = {}): ServerContext {
  return {
    mcpReq: {
      id: 1,
      method: 'tools/call',
      elicitInput: vi.fn(),
      ...overrides
    }
  } as unknown as ServerContext
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('describeSensitiveOperation', () => {
  it('returns null for non-messages tools and read-only actions', () => {
    expect(describeSensitiveOperation('folders', { action: 'list' }, false)).toBeNull()
    expect(describeSensitiveOperation('messages', { action: 'search', query: 'hi' }, false)).toBeNull()
    expect(describeSensitiveOperation('messages', { action: 'read', uid: 1 }, false)).toBeNull()
  })

  it('skips elicitation for draft sends or draft-only mode', () => {
    expect(
      describeSensitiveOperation('messages', { action: 'new', to: 'a@b.com', body: 'hello', draft: true }, false)
    ).toBeNull()
    expect(describeSensitiveOperation('messages', { action: 'new', to: 'a@b.com', body: 'hello' }, true)).toBeNull()
  })

  it('skips elicitation when required send or trash fields are missing so validation errors surface cleanly', () => {
    expect(describeSensitiveOperation('messages', { action: 'new', body: 'missing to' }, false)).toBeNull()
    expect(describeSensitiveOperation('messages', { action: 'forward', to: 'a@b.com' }, false)).toBeNull()
    expect(describeSensitiveOperation('messages', { action: 'reply' }, false)).toBeNull()
    expect(describeSensitiveOperation('messages', { action: 'trash' }, false)).toBeNull()
    expect(describeSensitiveOperation('messages', { action: 'trash', uids: [] }, false)).toBeNull()
  })

  it('builds confirmation prompts for outbound send actions and trash', () => {
    const newPrompt = describeSensitiveOperation(
      'messages',
      { action: 'new', to: 'a@b.com', subject: 'Hello', body: 'world' },
      false
    )
    expect(newPrompt).toEqual({
      key: 'confirm_send_email',
      message: 'Confirm sending email (new) to a@b.com ("Hello")?'
    })

    const replyPrompt = describeSensitiveOperation('messages', { action: 'reply', uid: 1, body: 'ok' }, false)
    expect(replyPrompt).toEqual({
      key: 'confirm_send_email',
      message: 'Confirm sending email (reply)?'
    })

    const trashPrompt = describeSensitiveOperation(
      'messages',
      { action: 'trash', uids: [1, 2], account: 'me@example.com' },
      false
    )
    expect(trashPrompt).toEqual({
      key: 'confirm_trash_email',
      message: 'Confirm moving 2 message(s) in me@example.com to Trash?'
    })

    const singleTrash = describeSensitiveOperation('messages', { action: 'trash', uid: 7 }, false)
    expect(singleTrash?.message).toBe('Confirm moving 1 message(s) to Trash?')
  })
})

describe('confirmSensitiveOperation', () => {
  it('proceeds immediately for non-sensitive operations and CLI/headless contexts', async () => {
    expect(await confirmSensitiveOperation('messages', { action: 'search' }, mockContext())).toEqual({
      status: 'proceed'
    })
    expect(await confirmSensitiveOperation('messages', { action: 'trash', uid: 1 }, undefined, false)).toEqual({
      status: 'proceed'
    })
    expect(
      await confirmSensitiveOperation(
        'messages',
        { action: 'trash', uid: 1 },
        { mcpReq: { id: 1, method: 'tools/call' } } as unknown as ServerContext,
        false
      )
    ).toEqual({ status: 'proceed' })
    expect(elicitWithFallbackMock).not.toHaveBeenCalled()
  })

  it('returns input_required when elicitWithFallback yields MRTR challenge', async () => {
    const challenge = { resultType: 'input_required', inputRequests: { confirm_trash_email: {} } }
    elicitWithFallbackMock.mockResolvedValue({ status: 'input_required', result: challenge })

    const outcome = await confirmSensitiveOperation('messages', { action: 'trash', uid: 1 }, mockContext(), false)
    expect(outcome).toEqual({ status: 'input_required', result: challenge })
  })

  it('maps accepted, fallback, declined, and cancelled outcomes accurately', async () => {
    elicitWithFallbackMock.mockResolvedValueOnce({ status: 'accepted', data: { confirmed: true }, source: 'mrtr' })
    expect(
      await confirmSensitiveOperation('messages', { action: 'new', to: 'a@b.com', body: 'hi' }, mockContext(), false)
    ).toEqual({ status: 'proceed' })

    elicitWithFallbackMock.mockResolvedValueOnce({
      status: 'fallback',
      data: { confirmed: true },
      reason: 'elicitation_unsupported'
    })
    expect(
      await confirmSensitiveOperation('messages', { action: 'new', to: 'a@b.com', body: 'hi' }, mockContext(), false)
    ).toEqual({ status: 'proceed' })

    elicitWithFallbackMock.mockResolvedValueOnce({ status: 'accepted', data: { confirmed: false }, source: 'legacy' })
    expect(await confirmSensitiveOperation('messages', { action: 'trash', uid: 1 }, mockContext(), false)).toEqual({
      status: 'cancelled',
      reason: 'declined'
    })

    elicitWithFallbackMock.mockResolvedValueOnce({ status: 'declined', data: undefined })
    expect(await confirmSensitiveOperation('messages', { action: 'trash', uid: 1 }, mockContext(), false)).toEqual({
      status: 'cancelled',
      reason: 'declined'
    })

    elicitWithFallbackMock.mockResolvedValueOnce({ status: 'cancelled', data: undefined })
    expect(await confirmSensitiveOperation('messages', { action: 'trash', uid: 1 }, mockContext(), false)).toEqual({
      status: 'cancelled',
      reason: 'cancelled'
    })
  })
})
