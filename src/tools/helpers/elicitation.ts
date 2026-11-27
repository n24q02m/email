import type { InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { elicitWithFallback } from '@n24q02m/hull'
import { z } from 'zod'
import { isDraftOnly } from './draft-only.js'

const CONFIRMATION_SCHEMA = z.object({
  confirmed: z.boolean().describe('Set true to confirm executing this sensitive email operation')
})

export interface SensitiveOperationPrompt {
  key: string
  message: string
}

export type ConfirmationOutcome =
  | { status: 'proceed' }
  | { status: 'input_required'; result: InputRequiredResult }
  | { status: 'cancelled'; reason: 'declined' | 'cancelled' }

/**
 * Determine whether a tool invocation performs a sensitive side effect
 * (non-draft outbound mail or moving messages to Trash) that benefits from user confirmation.
 */
export function describeSensitiveOperation(
  toolName: string,
  args: Record<string, unknown>,
  draftOnly: boolean = isDraftOnly()
): SensitiveOperationPrompt | null {
  if (toolName !== 'messages') {
    return null
  }

  const action = args.action
  if (action === 'trash') {
    const uidCount = Array.isArray(args.uids) ? args.uids.length : args.uid ? 1 : 0
    if (uidCount === 0) return null
    const accountLabel = typeof args.account === 'string' && args.account.trim() ? ` in ${args.account.trim()}` : ''
    return {
      key: 'confirm_trash_email',
      message: `Confirm moving ${uidCount} message(s)${accountLabel} to Trash?`
    }
  }

  if ((action === 'new' || action === 'reply' || action === 'forward') && args.draft !== true && !draftOnly) {
    const hasBody = typeof args.body === 'string' && args.body.length > 0
    const hasTo = typeof args.to === 'string' && args.to.length > 0
    if (!hasBody || ((action === 'new' || action === 'forward') && !hasTo)) {
      return null
    }
    const target = hasTo ? ` to ${String(args.to)}` : ''
    const subject = typeof args.subject === 'string' && args.subject ? ` ("${args.subject}")` : ''
    return {
      key: 'confirm_send_email',
      message: `Confirm sending email (${action})${target}${subject}?`
    }
  }

  return null
}

function hasInteractiveMcpContext(ctx?: ServerContext): ctx is ServerContext {
  if (!ctx?.mcpReq) return false
  return (
    typeof ctx.mcpReq.elicitInput === 'function' ||
    ctx.mcpReq.inputResponses !== undefined ||
    ctx.mcpReq.envelope !== undefined
  )
}

/**
 * Request interactive confirmation for sensitive email operations via `elicitWithFallback`,
 * automatically falling back to proceeding in CLI/headless environments or clients without elicitation.
 */
export async function confirmSensitiveOperation(
  toolName: string,
  args: Record<string, unknown>,
  ctx?: ServerContext,
  draftOnly: boolean = isDraftOnly()
): Promise<ConfirmationOutcome> {
  const prompt = describeSensitiveOperation(toolName, args, draftOnly)
  if (!prompt) {
    return { status: 'proceed' }
  }

  // CLI / headless fallback: proceed without blocking non-interactive callers.
  if (!hasInteractiveMcpContext(ctx)) {
    return { status: 'proceed' }
  }

  const outcome = await elicitWithFallback(ctx, {
    key: prompt.key,
    message: prompt.message,
    requestedSchema: CONFIRMATION_SCHEMA,
    schema: CONFIRMATION_SCHEMA,
    defaultValue: { confirmed: true }
  })

  if (outcome.status === 'input_required') {
    return { status: 'input_required', result: outcome.result }
  }
  if (outcome.status === 'cancelled') {
    return { status: 'cancelled', reason: 'cancelled' }
  }
  if (outcome.status === 'declined' || !outcome.data.confirmed) {
    return { status: 'cancelled', reason: 'declined' }
  }
  return { status: 'proceed' }
}
