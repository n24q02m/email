/**
 * Tool Registry - 5 Public Tools
 * Consolidated registration for maximum coverage with minimal tools
 *
 * Credential-aware: when state is 'awaiting_setup', tools return instructions
 * for supplying credentials (EMAIL_CREDENTIALS or the `email auth` CLI).
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { getState } from '../credential-state.js'
import { type AttachmentsInput, attachments } from './composite/attachments.js'
import { type ConfigInput, handleConfig } from './composite/config.js'
import { type FoldersInput, folders } from './composite/folders.js'
import { type MessagesInput, messages } from './composite/messages.js'
// Import mega tools
import { type AccountConfig, loadConfig } from './helpers/config.js'
import { aiReadableMessage, EmailMCPError, enhanceError, findClosestMatch } from './helpers/errors.js'
import { isValidToolName, markStructuredContent, wrapToolResult } from './helpers/security.js'

// Get docs directory path - works for both bundled CLI and unbundled code
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// For bundled CLI: __dirname = /bin/, docs at /build/src/docs/
// For unbundled: __dirname = /build/src/tools/, docs at /build/src/docs/
const DOCS_DIR = __dirname.endsWith('bin')
  ? join(__dirname, '..', 'build', 'src', 'docs')
  : join(__dirname, '..', 'docs')

/**
 * Documentation resources for full tool details
 */
const RESOURCES = [
  { uri: 'email://docs/messages', name: 'Messages Tool Docs', file: 'messages.md' },
  { uri: 'email://docs/folders', name: 'Folders Tool Docs', file: 'folders.md' },
  { uri: 'email://docs/attachments', name: 'Attachments Tool Docs', file: 'attachments.md' },
  { uri: 'email://docs/help', name: 'Help Tool Docs', file: 'help.md' },
  { uri: 'email://docs/config', name: 'Config Tool Docs', file: 'config.md' }
]

/**
 * 5 Tools covering full email operations
 * Compressed descriptions for token optimization
 */
const TOOLS = [
  {
    name: 'messages',
    description:
      'Search, read, manage, compose, and send email messages.\n\nActions (required params -> optional):\n- search (-> account, query="UNSEEN", folder="INBOX", limit=20)\n- read (account, uid -> folder, preview, max_chars)\n- mark_read / mark_unread / flag / unflag (account, uid|uids -> folder)\n- move (account, uid|uids, destination -> folder)\n- archive / trash (account, uid|uids -> folder)\n- new (account, to, subject, body -> cc, bcc, attachments)\n- reply (account, uid, body -> to, folder, attachments)\n- forward (account, uid, to, body -> folder, attachments)\n\nRead preview mode returns at most max_chars (default 4000) and includes truncation metadata; omit preview for the full body.\n\nQuery examples: "UNREAD", "FROM user@example.com", "SINCE 2026-01-01", "UNREAD FROM boss@company.com". Date format MUST be YYYY-MM-DD.\n\nOutbound bodies support plain text or HTML. Attachments use base64 content, max 10 files and 25MB decoded total.',
    annotations: {
      title: 'Messages',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'search',
            'read',
            'mark_read',
            'mark_unread',
            'flag',
            'unflag',
            'move',
            'archive',
            'trash',
            'new',
            'reply',
            'forward'
          ],
          description: 'Action to perform'
        },
        account: { type: 'string', description: 'Account email filter (optional, defaults to all for search)' },
        query: {
          type: 'string',
          description:
            'IMAP search query (default: UNSEEN). Single: UNREAD, FLAGGED, SINCE YYYY-MM-DD, FROM email@example.com, SUBJECT text. Combined: UNREAD SINCE 2026-01-01, UNREAD FROM user@example.com. Dates MUST use YYYY-MM-DD format (e.g. 2026-03-21). Plain text is treated as subject search.'
        },
        folder: { type: 'string', description: 'Mailbox folder (default: INBOX)' },
        limit: { type: 'number', description: 'Max results for search (default: 20)' },
        uid: { type: 'number', description: 'Email UID (for read/modify single email)' },
        preview: { type: 'boolean', description: 'Read at most max_chars and return truncation metadata' },
        max_chars: {
          type: 'number',
          description: 'Preview body limit, integer 1-100000; defaults to 4000 when preview is true'
        },
        uids: { type: 'array', items: { type: 'number' }, description: 'Multiple UIDs for batch operations' },
        destination: { type: 'string', description: 'Target folder for move action' },
        to: {
          type: 'string',
          description:
            'Recipient email address (required for new/forward, optional for reply - auto-derived from original sender)'
        },
        subject: { type: 'string', description: 'Email subject (required for new)' },
        body: {
          type: 'string',
          description: 'Email body (required for new/reply/forward). Use plain text or HTML, not both.'
        },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
        attachments: {
          type: 'array',
          description: 'File attachments to include (optional). Max 10 files, total decoded size <= 25MB.',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Attachment filename' },
              content_base64: { type: 'string', description: 'File content encoded as base64' },
              content_type: { type: 'string', description: 'MIME type (optional, e.g. application/pdf)' }
            },
            required: ['filename', 'content_base64']
          }
        }
      },
      required: ['action']
    },
    outputSchema: { type: 'object', additionalProperties: true }
  },
  {
    name: 'folders',
    description:
      'List mailbox folders or read targeted mailbox status metadata.\n\nActions (required params -> optional):\n- list (-> account): folder names, paths, and flags for one or all accounts\n- status (account, folder): IMAP STATUS messages, unseen, and uid_next for exactly one mailbox',
    annotations: {
      title: 'Folders',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status'],
          description: 'Action to perform'
        },
        account: {
          type: 'string',
          description: 'Account email or ID (required for status; optional list filter, defaults to all)'
        },
        folder: { type: 'string', description: 'Exact mailbox path (required for status, for example INBOX)' }
      },
      required: ['action']
    },
    outputSchema: { type: 'object', additionalProperties: true }
  },
  {
    name: 'attachments',
    description:
      'List and download email attachments.\n\nActions (required params -> optional):\n- list (account, uid -> folder): show attachments with filename, content_type, size\n- download (account, uid, filename -> folder): get base64-encoded content\n\nUse list first to get exact filenames. Case-sensitive. Max 25MB per provider.',
    annotations: {
      title: 'Attachments',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'download'],
          description: 'Action to perform'
        },
        account: { type: 'string', description: 'Account email (required)' },
        uid: { type: 'number', description: 'Email UID (required)' },
        folder: { type: 'string', description: 'Mailbox folder (default: INBOX)' },
        filename: {
          type: 'string',
          description: 'Exact attachment filename from list action (required for download). Case-sensitive.'
        }
      },
      required: ['action', 'account', 'uid']
    },
    outputSchema: { type: 'object', additionalProperties: true }
  },
  {
    name: 'config',
    description:
      'Manage email credential setup and runtime configuration.\n\nSetup actions (credential lifecycle):\n- status: Show current credential state and configured accounts\n- setup_status: Show credential state only (no accounts list; cross-server parity action)\n- setup_start: Show how to supply credentials (EMAIL_CREDENTIALS env var or `email auth` CLI)\n- setup_reset: Clear stored credentials and reset to awaiting_setup state\n- setup_complete: Re-check credential state after credentials were supplied\n\nRuntime actions:\n- set: Update runtime settings (email has no runtime settings; returns ok=false)\n- cache_clear: Clear IMAP folder caches and the OAuth token cache',
    annotations: {
      title: 'Config',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'setup_status', 'setup_start', 'setup_reset', 'setup_complete', 'set', 'cache_clear'],
          description: 'Action to perform'
        }
      },
      required: ['action']
    },
    outputSchema: { type: 'object', additionalProperties: true }
  },
  {
    name: 'help',
    description: 'Get full documentation for a tool. Use when compressed descriptions are insufficient.',
    annotations: {
      title: 'Help',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          enum: ['messages', 'folders', 'attachments', 'config', 'help'],
          description: 'Tool to get documentation for'
        }
      },
      required: ['tool_name']
    }
  }
]

/**
 * Register all tools with MCP server
 */

async function handleHelp(args: unknown): Promise<{ tool: string; documentation: string }> {
  const toolName = (args as { tool_name: string }).tool_name
  if (!isValidToolName(toolName)) {
    throw new EmailMCPError(
      `Invalid tool name: ${toolName}`,
      'VALIDATION_ERROR',
      'Valid: messages, folders, attachments, config, help'
    )
  }
  const resource = RESOURCES.find((r) => r.uri === `email://docs/${toolName}`)
  if (!resource) {
    throw new EmailMCPError(`Documentation not found for: ${toolName}`, 'DOC_NOT_FOUND', 'Check tool_name')
  }
  try {
    const content = await readFile(join(DOCS_DIR, resource.file), 'utf-8')
    return { tool: toolName, documentation: content }
  } catch {
    throw new EmailMCPError(`Documentation not found for: ${toolName}`, 'DOC_NOT_FOUND', 'Check tool_name')
  }
}

type ToolHandler = (accounts: AccountConfig[], args: unknown) => Promise<unknown>

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  messages: (accounts, args) => messages(accounts, args as unknown as MessagesInput),
  folders: (accounts, args) => folders(accounts, args as unknown as FoldersInput),
  attachments: (accounts, args) => attachments(accounts, args as unknown as AttachmentsInput),
  config: (accounts, args) => handleConfig(accounts, args as unknown as ConfigInput),
  help: (_, args) => handleHelp(args)
}

// Pre-compute derived values to avoid redundant allocations on every request
const FORMATTED_RESOURCES = RESOURCES.map((r) => ({
  uri: r.uri,
  name: r.name,
  mimeType: 'text/markdown'
}))
const AVAILABLE_RESOURCE_URIS_STRING = RESOURCES.map((r) => r.uri).join(', ')
const VALID_TOOL_NAMES = TOOLS.map((t) => t.name)
const AVAILABLE_TOOLS_STRING = VALID_TOOL_NAMES.join(', ')

export function registerTools(server: Server, initialAccounts: AccountConfig[]) {
  // Mutable reference: updated when credentials are saved after startup
  let accounts = initialAccounts
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
  }))

  // Resources handlers for full documentation
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: FORMATTED_RESOURCES
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    const resource = RESOURCES.find((r) => r.uri === uri)

    if (!resource) {
      throw new EmailMCPError(
        `Resource not found: ${uri}`,
        'RESOURCE_NOT_FOUND',
        `Available: ${AVAILABLE_RESOURCE_URIS_STRING}`
      )
    }

    const content = await readFile(join(DOCS_DIR, resource.file), 'utf-8')
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: content }]
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    if (!args) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No arguments provided'
          }
        ],
        isError: true
      }
    }

    try {
      const handler = TOOL_HANDLERS[name]
      if (!handler) {
        const closest = findClosestMatch(name, VALID_TOOL_NAMES)
        const suggestion = closest ? ` Did you mean '${closest}'?` : ''
        throw new EmailMCPError(
          `Unknown tool: ${name}.${suggestion}`,
          'UNKNOWN_TOOL',
          `Available tools: ${AVAILABLE_TOOLS_STRING}`
        )
      }

      // Credential guard: when not configured, return setup instructions.
      // Help and config manage the credential lifecycle themselves (docs need no credentials).
      // In stdio mode, missing creds are caught up-front in init-server.ts (process.exit(1)).
      if (name !== 'help' && name !== 'config' && accounts.length === 0) {
        const credState = getState()
        if (credState === 'configured') {
          // Credentials were saved after startup (e.g. `email auth`): reload accounts
          accounts = await loadConfig()
        } else {
          return {
            content: [
              {
                type: 'text',
                text: 'Email credentials are not configured.\n\nSet EMAIL_CREDENTIALS (or EMAIL_USER + EMAIL_APP_PASSWORD), or run `email auth outlook <address>` for Outlook.'
              }
            ],
            isError: true
          }
        }
      }

      const configInput = name === 'config' ? (args as unknown as ConfigInput) : undefined
      const result = await handler(accounts, args)

      // A server instance is reused for every MCP request in one session. After a
      // successful reset, clear the in-memory account snapshot as well as the
      // durable store so the next tool call cannot continue with deleted credentials.
      if (configInput?.action === 'setup_reset') {
        accounts.length = 0
      }

      const jsonText = JSON.stringify(result, null, 2)
      return {
        content: [
          {
            type: 'text',
            text: wrapToolResult(name, jsonText)
          }
        ],
        // help returns markdown-style docs by design (constraint: no structured envelope).
        // External-content tools (messages, attachments) get an untrusted-source marker
        // at the envelope level since structuredContent bypasses wrapToolResult's XML tag.
        ...(name !== 'help'
          ? { structuredContent: markStructuredContent(name, result as Record<string, unknown>) }
          : {})
      }
    } catch (error) {
      const enhancedError = error instanceof EmailMCPError ? error : enhanceError(error)

      return {
        content: [
          {
            type: 'text',
            text: aiReadableMessage(enhancedError)
          }
        ],
        isError: true
      }
    }
  })
}
