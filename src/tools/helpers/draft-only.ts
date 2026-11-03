/**
 * Draft-only mode (EMAIL_MCP_DRAFT_ONLY=1).
 *
 * For servers driven by an agent that reads untrusted mail: a prompt-injected agent must not be able
 * to send, forward, or destroy mail. new/reply/forward are composed as usual but appended to the
 * account's Drafts folder instead of going out over SMTP. The actions in DRAFT_ONLY_REFUSED are taken
 * off the advertised tool surface, and refused if called anyway. Search, read and flag changes stay.
 */

import { EmailMCPError } from './errors.js'

export const DRAFT_ONLY_ENV = 'EMAIL_MCP_DRAFT_ONLY'

/** Actions that do not exist in draft-only mode, per tool. */
export const DRAFT_ONLY_REFUSED: Readonly<Record<string, readonly string[]>> = {
  messages: ['move', 'archive', 'trash'],
  config: ['setup_reset']
}

const MESSAGES_NOTE =
  '\n\nDRAFT-ONLY MODE: new/reply/forward save the message to the Drafts folder of the account and do NOT send it; the user reviews and sends it.'

export function isDraftOnly(): boolean {
  const value = process.env[DRAFT_ONLY_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function refuseInDraftOnly(tool: string, action: string): void {
  if (!isDraftOnly() || !DRAFT_ONLY_REFUSED[tool]?.includes(action)) return
  throw new EmailMCPError(
    `${action} is disabled: this server runs in draft-only mode`,
    'DRAFT_ONLY',
    'Only search, read, flag changes and drafting (new/reply/forward save to Drafts) are allowed. Ask the user to do this themselves.'
  )
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: { properties: Record<string, any> }
}

/**
 * The tool as advertised in draft-only mode: refused actions are dropped from the action enum and
 * from the description's action list, so the agent never sees them.
 */
export function restrictTool<T extends ToolDefinition>(tool: T): T {
  const refused = DRAFT_ONLY_REFUSED[tool.name]
  if (!refused) return tool
  const properties = { ...tool.inputSchema.properties }
  const action = properties.action
  if (action?.enum) {
    properties.action = { ...action, enum: action.enum.filter((a: string) => !refused.includes(a)) }
  }
  if (tool.name === 'messages') {
    delete properties.destination // only used by move
    delete properties.draft // every outbound message is a draft
  }
  const description = tool.description
    .split('\n')
    .filter((line) => {
      const names = /^- ([a-z_ /]+?) \(/.exec(line)?.[1]?.split(' / ')
      return !names?.every((n) => refused.includes(n))
    })
    .join('\n')
    .replaceAll(', draft)', ')')
  return {
    ...tool,
    description: tool.name === 'messages' ? description + MESSAGES_NOTE : description,
    inputSchema: { ...tool.inputSchema, properties }
  }
}
