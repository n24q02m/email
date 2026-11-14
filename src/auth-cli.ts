/**
 * CLI for OAuth2 authentication (Device Code flow) + local session logout.
 *
 * Usage:
 *   npx @n24q02m/email auth [outlook] user@outlook.com [--client-id=<id>] [--user=<namespace>]
 *   npx @n24q02m/email logout [user@outlook.com] [--user=<namespace>]
 *
 * `--user <namespace>` targets one HTTP multi-user namespace: the grant is saved
 * to (or cleared from) `<data dir>/users/<namespace>/tokens.json`, which only a
 * caller whose users.toml row carries that namespace can use.
 *
 * The leading `outlook` provider positional is optional (email has a single
 * OAuth2 provider today) -- kept for CLI naming parity with wet/mnemo's
 * `auth <provider>` and telegram's `auth [<provider>]`, per the WS5 CLI/auth
 * naming standard. `--client-id` is single-user / local-machine only, same
 * scope as the rest of this CLI (per tool-layout.md CLI Surface invariants).
 */

import { join } from 'node:path'
import { resolveDataDir } from './data-dir.js'
import { runAsNamespace } from './tenant.js'
import { deleteStoredTokens, deviceCodeAuth, isOutlookDomain } from './tools/helpers/oauth2.js'

const KNOWN_PROVIDERS = new Set(['outlook'])

interface ParsedArgs {
  positionals: string[]
  clientId: string | null
  user: string | null
}

/** Split CLI args into positionals and the `--client-id[=value]` / `--user[=value]` flags. */
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  let clientId: string | null = null
  let user: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg.startsWith('--client-id=')) {
      clientId = arg.slice('--client-id='.length)
    } else if (arg === '--client-id') {
      i += 1
      clientId = argv[i] ?? null
    } else if (arg.startsWith('--user=')) {
      user = arg.slice('--user='.length)
    } else if (arg === '--user') {
      i += 1
      user = argv[i] ?? null
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, clientId, user }
}

/** Run `fn` as the `--user` namespace when one was given, else as the local user. */
function asUser<T>(user: string | null, fn: () => T): T {
  return user === null ? fn() : runAsNamespace(user.trim(), fn)
}

/** Drop a leading known-provider positional (e.g. `outlook`), if present. */
function stripProvider(positionals: string[]): string[] {
  const [first, ...rest] = positionals
  return first && KNOWN_PROVIDERS.has(first.toLowerCase()) ? rest : positionals
}

export async function runAuth(): Promise<void> {
  const { positionals, clientId, user } = parseArgs(process.argv.slice(3))
  const email = stripProvider(positionals)[0]?.trim()

  if (!email) {
    console.error('Usage: email auth [outlook] <email> [--client-id=<id>] [--user=<namespace>]')
    console.error('Example: email auth user@outlook.com')
    console.error('')
    console.error('Authenticates an Outlook/Hotmail/Live account via OAuth2 Device Code flow.')
    console.error(`Tokens are saved to ${join(resolveDataDir(), 'tokens.json')}`)
    console.error('With --user, they are saved for that HTTP multi-user namespace instead.')
    process.exit(1)
  }

  if (!isOutlookDomain(email)) {
    console.error(`OAuth2 auth is only needed for Outlook/Hotmail/Live accounts.`)
    console.error(`For ${email}, use an App Password in EMAIL_CREDENTIALS instead.`)
    process.exit(1)
  }

  try {
    await asUser(user, async () => {
      if (clientId) {
        await deviceCodeAuth(email, clientId)
      } else {
        await deviceCodeAuth(email)
      }
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\nError: ${message}`)
    process.exit(1)
  }
}

export async function runLogout(): Promise<void> {
  const { positionals, user } = parseArgs(process.argv.slice(3))
  const email = stripProvider(positionals)[0]?.trim()

  const deleted = await asUser(user, () => deleteStoredTokens(email || undefined))
  if (deleted.length === 0) {
    console.error(
      email ? `Nothing to log out (no saved token for ${email}).` : 'Nothing to log out (no saved Outlook tokens).'
    )
    return
  }
  console.error(`Logged out. Cleared token(s) for: ${deleted.join(', ')}`)
}
