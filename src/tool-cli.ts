/**
 * Tool CLI — one console subcommand per MCP tool.
 *
 * `email <tool> <action> [--flag value ...] [--json]` turns argv into the
 * tool's input object using the very JSON Schema the MCP server advertises
 * (`TOOLS`), then calls `invokeTool` — the same dispatch table `registerTools`
 * installs. One handler implementation therefore serves both callers, and
 * there is no second list of flags to keep in sync.
 *
 * Output contract: the tool result goes to stdout as JSON with `--json` and as
 * human-readable text otherwise. A failure prints one message to stderr and
 * exits 1 — never a stack trace.
 *
 * `config` is the one tool whose name collides with a built-in operator
 * command (`email config status|delete`, from hull's `buildCli`). The operator
 * command keeps the name; the tool is reachable as `config-tool`.
 */

import { resolveCredentialState } from './credential-state.js'
import type { AccountConfig } from './tools/helpers/config.js'
import { loadConfig } from './tools/helpers/config.js'
import { aiReadableMessage, EmailMCPError, enhanceError, NOT_CONFIGURED_MESSAGE } from './tools/helpers/errors.js'
import { invokeTool, TOOLS } from './tools/registry.js'

const PROGRAM = 'email'

/**
 * CLI command name -> MCP tool name. Every registered tool needs a row: the
 * parity test in `tool-cli.test.ts` derives the registry's tool names and fails
 * when one has no command, so a tool cannot stay MCP-only by accident. Only the
 * `config` tool needs a short name because the operator `config` command owns
 * its own.
 */
export const TOOL_COMMANDS: Record<string, string> = {
  messages: 'messages',
  folders: 'folders',
  attachments: 'attachments',
  'config-tool': 'config',
  help: 'help'
}

/** The CLI command that runs `toolName`, or `undefined` when the tool has no row. */
export function commandForTool(toolName: string): string | undefined {
  return Object.keys(TOOL_COMMANDS).find((command) => TOOL_COMMANDS[command] === toolName)
}

/**
 * Tool names with no CLI command, in input order.
 *
 * The parity test asserts this is empty for `TOOLS`, so a registry tool added
 * without a `TOOL_COMMANDS` row fails CI together with the tool's name instead
 * of quietly reaching only MCP clients.
 */
export function unmappedTools(
  toolNames: readonly string[],
  commands: Record<string, string> = TOOL_COMMANDS
): string[] {
  const mapped = new Set(Object.values(commands))
  return toolNames.filter((name) => !mapped.has(name))
}

/** Tools that answer without credentials (docs and the credential lifecycle itself). */
const CREDENTIAL_FREE_TOOLS: Record<string, true> = { help: true, config: true }

const TRUE_WORDS: Record<string, true> = { '': true, true: true, '1': true, yes: true }
const FALSE_WORDS: Record<string, true> = { false: true, '0': true, no: true }

// ---------------------------------------------------------------------------
// schema view
// ---------------------------------------------------------------------------

/** The subset of JSON Schema the tool definitions use. */
interface SchemaProperty {
  type?: string
  description?: string
  enum?: unknown[]
  items?: SchemaProperty
}

interface ToolSchema {
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolSchema
}

const DEFINITIONS = TOOLS as unknown as ToolDefinition[]

function findDefinition(toolName: string): ToolDefinition {
  const definition = DEFINITIONS.find((candidate) => candidate.name === toolName)
  if (!definition) {
    const available = DEFINITIONS.map((candidate) => candidate.name).join(', ')
    throw new EmailMCPError(`Unknown tool: ${toolName}`, 'UNKNOWN_TOOL', `Available tools: ${available}`)
  }
  return definition
}

/**
 * The positional argument: `action` when the tool has one, otherwise the first
 * required property (the `help` tool's `tool_name`).
 */
function positionalName(schema: ToolSchema): string | undefined {
  if (schema.properties?.action) return 'action'
  return schema.required?.[0]
}

/** Usage line shared by the parse errors and `--help`. */
function usageLine(command: string, positional?: string): string {
  return `${PROGRAM} ${command}${positional ? ` <${positional}>` : ''} [options]`
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

interface ParsedInvocation {
  input: Record<string, unknown>
  json: boolean
  help: boolean
}

function readBoolean(raw: string, name: string, subject = `--${name}`): boolean {
  const normalized = raw.trim().toLowerCase()
  if (TRUE_WORDS[normalized]) return true
  if (FALSE_WORDS[normalized]) return false
  throw new EmailMCPError(
    `${subject} expects true or false, got '${raw}'`,
    'VALIDATION_ERROR',
    `Use --${name} or --no-${name}`
  )
}

function readJson(raw: string, subject: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new EmailMCPError(`${subject} expects JSON, got '${raw}'`, 'VALIDATION_ERROR', `Example: ${subject} '[...]'`)
  }
}

function readArray(raw: string, property: SchemaProperty, name: string, subject: string): unknown[] {
  const trimmed = raw.trim()
  if (trimmed === '') return []
  if (trimmed.startsWith('[')) {
    const parsed = readJson(trimmed, subject)
    if (!Array.isArray(parsed)) {
      throw new EmailMCPError(
        `${subject} expects a JSON array, got '${raw}'`,
        'VALIDATION_ERROR',
        `Example: ${subject} '[...]'`
      )
    }
    return parsed
  }
  const items = property.items ?? {}
  return trimmed.split(',').map((part) => coerceValue(part.trim(), items, name, subject))
}

/**
 * Convert one raw argv value to the type the tool schema declares.
 *
 * `subject` is how the argument is spelled on the command line (`--limit` for a
 * flag, `<action>` for the positional) so the error names what the user typed.
 */
function coerceValue(raw: string, property: SchemaProperty, name: string, subject = `--${name}`): unknown {
  switch (property.type) {
    case 'number':
    case 'integer': {
      const value = Number(raw)
      const ok = Number.isFinite(value) && (property.type !== 'integer' || Number.isInteger(value))
      if (!ok) {
        throw new EmailMCPError(
          `${subject} expects ${property.type === 'integer' ? 'an integer' : 'a number'}, got '${raw}'`,
          'VALIDATION_ERROR',
          `Provide a numeric ${subject}`
        )
      }
      return value
    }
    case 'boolean':
      return readBoolean(raw, name, subject)
    case 'array':
      return readArray(raw, property, name, subject)
    case 'object':
      return readJson(raw, subject)
    default: {
      if (property.enum && !property.enum.includes(raw)) {
        throw new EmailMCPError(
          `${subject}: invalid value '${raw}'`,
          'VALIDATION_ERROR',
          `Valid values: ${property.enum.join(', ')}`
        )
      }
      return raw
    }
  }
}

function unknownOption(raw: string, properties: Record<string, SchemaProperty>): EmailMCPError {
  const valid = Object.keys(properties)
    .map((name) => `--${name}`)
    .join(', ')
  return new EmailMCPError(`Unknown option: --${raw}`, 'VALIDATION_ERROR', `Valid options: ${valid}, --json, --help`)
}

function parseInvocation(argv: string[], schema: ToolSchema, command: string): ParsedInvocation {
  const properties = schema.properties ?? {}
  const input: Record<string, unknown> = {}
  const positionals: string[] = []
  let json = false
  let help = false

  for (let index = 0; index < argv.length; index++) {
    const arg: string = argv[index]

    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const rawName = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
      const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1)
      // `--no-preview` is the explicit false form for a boolean tool argument.
      const negated = rawName.startsWith('no-') && !properties[rawName] && !!properties[rawName.slice(3)]
      const name = negated ? rawName.slice(3) : rawName
      const property = properties[name]

      if (!property) throw unknownOption(rawName, properties)

      if (inlineValue !== undefined) {
        input[name] = negated ? !readBoolean(inlineValue, name) : coerceValue(inlineValue, property, name)
        continue
      }
      if (negated) {
        input[name] = false
        continue
      }
      if (property.type === 'boolean') {
        const next: string | undefined = argv[index + 1]
        if (next !== undefined && !next.startsWith('-')) {
          input[name] = readBoolean(next, name)
          index++
        } else {
          input[name] = true
        }
        continue
      }
      const next: string | undefined = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new EmailMCPError(
          `${command}: --${name} needs a value`,
          'VALIDATION_ERROR',
          `Usage: ${usageLine(command)} --${name} <value>`
        )
      }
      input[name] = coerceValue(next, property, name)
      index++
      continue
    }

    if (arg.startsWith('-') && arg !== '-') throw unknownOption(arg.slice(1), properties)
    positionals.push(arg)
  }

  const positional = positionalName(schema)
  for (const value of positionals) {
    if (positional && input[positional] === undefined) {
      input[positional] = coerceValue(value, properties[positional] ?? {}, positional, `<${positional}>`)
      continue
    }
    throw new EmailMCPError(
      `${command}: unexpected argument '${value}'`,
      'VALIDATION_ERROR',
      `Usage: ${usageLine(command, positional)}`
    )
  }

  for (const name of schema.required ?? []) {
    // `--help` is answered before dispatch, so a missing positional must not
    // turn `<command> --help` into a usage error.
    if (help) break
    if (input[name] === undefined) {
      throw new EmailMCPError(
        `${PROGRAM} ${command}: missing required argument <${name}>`,
        'VALIDATION_ERROR',
        `Usage: ${usageLine(command, positional)}`
      )
    }
  }

  return { input, json, help }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function formatArray(items: unknown[], indent: string): string[] {
  const lines: string[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      lines.push(`${indent}- ${String(item)}`)
      continue
    }
    if (Array.isArray(item)) {
      lines.push(`${indent}-`)
      lines.push(...formatArray(item, `${indent}  `))
      continue
    }
    const record = item as Record<string, unknown>
    const flat: string[] = []
    const nested: [string, unknown][] = []
    for (const [key, child] of Object.entries(record)) {
      if (child === null || child === undefined) continue
      if (typeof child === 'object') nested.push([key, child])
      else flat.push(`${key}=${String(child)}`)
    }
    lines.push(flat.length > 0 ? `${indent}- ${flat.join(' ')}` : `${indent}-`)
    for (const [key, child] of nested) {
      if (Array.isArray(child) && child.length === 0) {
        lines.push(`${indent}  ${key}: (empty)`)
        continue
      }
      lines.push(`${indent}  ${key}:`)
      lines.push(...formatValue(child, `${indent}    `))
    }
  }
  return lines
}

function formatObject(record: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = []
  for (const [key, child] of Object.entries(record)) {
    if (child === null || child === undefined) continue
    if (Array.isArray(child) && child.length === 0) {
      lines.push(`${indent}${key}: (empty)`)
      continue
    }
    if (typeof child !== 'object') {
      lines.push(`${indent}${key}: ${String(child)}`)
      continue
    }
    lines.push(`${indent}${key}:`)
    lines.push(...formatValue(child, `${indent}  `))
  }
  return lines
}

/** Render a tool result as indented `key: value` lines (arrays as bullets). */
function formatValue(value: unknown, indent = ''): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return formatArray(value, indent)
  if (typeof value === 'object') return formatObject(value as Record<string, unknown>, indent)
  return [`${indent}${String(value)}`]
}

function humanResult(toolName: string, result: unknown): string {
  // `help` documents itself as markdown; print it verbatim instead of escaping it.
  if (toolName === 'help' && typeof result === 'object' && result !== null && 'documentation' in result) {
    const { documentation } = result
    if (typeof documentation === 'string') return documentation.trimEnd()
  }
  const lines = formatValue(result)
  return lines.length > 0 ? lines.join('\n') : 'ok'
}

function commandHelp(command: string, definition: ToolDefinition): string {
  const schema = definition.inputSchema
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const positional = positionalName(schema)
  const lines: string[] = [`usage: ${usageLine(command, positional)}`, '', definition.description, '']

  const actions = properties.action?.enum
  if (actions) {
    lines.push(`actions: ${actions.map(String).join(', ')}`, '')
  }

  lines.push('options:')
  for (const [name, property] of Object.entries(properties)) {
    if (name === positional) continue
    const label = `--${name}${property.type && property.type !== 'boolean' ? ` <${property.type}>` : ''}`
    const note = property.description ? ` ${property.description}` : ''
    lines.push(`  ${label.padEnd(28)}${note}${required.has(name) ? ' (required)' : ''}`)
  }
  const positionalProperty = positional ? properties[positional] : undefined
  if (positional && positionalProperty?.description) {
    lines.push(`  ${`<${positional}>`.padEnd(28)} ${positionalProperty.description} (required)`)
  }
  lines.push(`  ${'--json'.padEnd(28)} print the tool result as JSON`)
  lines.push(`  ${'-h, --help'.padEnd(28)} show this help`)
  lines.push('')
  lines.push(`Runs the same handler as the \`${definition.name}\` MCP tool.`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/** Same credential path as the server: env, stored config, then saved OAuth tokens. */
async function loadToolAccounts(toolName: string): Promise<AccountConfig[]> {
  if (toolName === 'help') return []
  await resolveCredentialState()
  const accounts = await loadConfig()
  if (!CREDENTIAL_FREE_TOOLS[toolName] && accounts.length === 0) {
    throw new EmailMCPError(NOT_CONFIGURED_MESSAGE, 'NOT_CONFIGURED')
  }
  return accounts
}

function errorText(error: unknown): string {
  return aiReadableMessage(error instanceof EmailMCPError ? error : enhanceError(error))
}

/**
 * Run one tool subcommand.
 *
 * Returns the process exit code: 0 on success, 1 on any failure (parse error,
 * missing credentials, or a handler error). Never throws.
 */
export async function runToolCommand(toolName: string, argv: string[]): Promise<number> {
  const command = commandForTool(toolName)
  if (command === undefined) {
    // Unreachable while the registry parity test holds: every tool has a
    // command. Refuse instead of guessing the raw tool name, which would make
    // an unmapped tool silently callable and invisible to the help text.
    process.stderr.write(`Tool ${toolName} has no CLI command; add it to TOOL_COMMANDS.\n`)
    return 1
  }
  let definition: ToolDefinition
  let parsed: ParsedInvocation
  try {
    definition = findDefinition(toolName)
    parsed = parseInvocation(argv, definition.inputSchema, command)
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`)
    return 1
  }

  if (parsed.help) {
    process.stdout.write(`${commandHelp(command, definition)}\n`)
    return 0
  }

  try {
    const accounts = await loadToolAccounts(toolName)
    const result = await invokeTool(toolName, accounts, parsed.input)
    process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${humanResult(toolName, result)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`)
    return 1
  }
}

/** `extra` handlers for hull's `buildCli`: one subcommand per MCP tool. */
export function toolCliHandlers(): Record<string, (argv: string[]) => Promise<number>> {
  const handlers: Record<string, (argv: string[]) => Promise<number>> = {}
  for (const [command, toolName] of Object.entries(TOOL_COMMANDS)) {
    handlers[command] = (argv) => runToolCommand(toolName, argv)
  }
  return handlers
}

/**
 * Grouped help, printed for `email --help`.
 *
 * Registered in `scripts/start-server.ts` before `buildCli` gets the argv:
 * `buildCli` prints one flat list of every handler, which would hide the line
 * between tool commands and operator commands.
 */
export function printCliHelp(programName = PROGRAM): void {
  const lines: string[] = [
    `usage: ${programName} [-h] [--version] [<command> [<action>] [options]]`,
    '',
    'server:',
    `  ${programName.padEnd(30)}start the MCP server over stdio (default)`,
    `  ${`${programName} --http`.padEnd(30)}start it over HTTP (single-user bearer token)`,
    '',
    'tool commands (same handlers as the MCP tools; add --json for machine output):'
  ]

  for (const [command, toolName] of Object.entries(TOOL_COMMANDS)) {
    const { inputSchema } = findDefinition(toolName)
    const positional = positionalName(inputSchema)
    const actions = (inputSchema.properties?.action?.enum ?? []).map(String).join(', ')
    const alias = command === toolName ? '' : ' (MCP tool `config`; `config` below is the operator command)'
    const label = `${command}${positional ? ` <${positional}>` : ''}`.padEnd(30)
    lines.push(`  ${label}${actions || 'full tool documentation'}${alias}`)
  }

  lines.push(
    '',
    'operator commands:',
    `  ${'auth [outlook] <email>'.padEnd(30)}Outlook/Hotmail/Live OAuth2 device-code sign-in`,
    `  ${'logout [<email>]'.padEnd(30)}clear stored Outlook token(s)`,
    `  ${'config status|delete'.padEnd(30)}stored credential file (hull built-in; delete needs --yes)`,
    `  ${'status'.padEnd(30)}alias of \`config status\``,
    `  ${'doctor'.padEnd(30)}runtime and credential health checks`,
    `  ${'token'.padEnd(30)}HTTP bearer-token helpers`,
    '',
    'flags:',
    `  ${'-h, --help'.padEnd(30)}this message (\`<command> --help\` for a command's flags)`,
    `  ${'--version, -V'.padEnd(30)}print the version`,
    `  ${'--json'.padEnd(30)}(tool commands) print the tool result as JSON`
  )

  process.stdout.write(`${lines.join('\n')}\n`)
}
