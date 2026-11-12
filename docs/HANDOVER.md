# email Handover

## Current product

`email` is an IMAP/SMTP MCP server for AI agents: search and read mail, compose/reply/forward, organise messages across folders, and list or download attachments over any standard mailbox. The published package is `@n24q02m/email`; the `email` binary also answers to its legacy name `better-email-mcp`, and the MCP Registry id is `io.github.n24q02m/email` (the entry published earlier under `io.github.n24q02m/better-email-mcp` stays frozen under that old name).

**Version: 1.42.0** -- the `version` field of `package.json` at the commit that added this handover. `semantic-release.toml` bumps `package.json`, `.claude-plugin/plugin.json`, and `server.json` together on every release, so treat this line as a snapshot and re-read `package.json` before using it as current.

The server runs on the MCP TypeScript SDK with hull (`@n24q02m/hull`) supplying the HTTP transport, bearer-token auth, the shared operator CLI, and the encrypted config store. Mail access is plain IMAP/SMTP through `imapflow` with `mailparser` in `src/tools/helpers/`, with provider settings auto-discovered from the address and a per-account override for custom hosts. There is no OAuth server, relay form, daemon proxy, or hosted endpoint; the one bundled OAuth flow is the Outlook/Hotmail/Live device-code sign-in described below.

Two transports: local stdio (default) and Streamable HTTP as a single-user server behind one shared bearer token.

The public contract is defined by the repository README, `server.json`, package metadata, and the documented MCP tools and resources.

## Current tool inventory

Three domain tools plus `config` and `help` (`src/tools/registry.ts` is the single published surface):

| Tool | Actions | Notes |
|---|---|---|
| `messages` | `search`, `read`, `mark_read`, `mark_unread`, `flag`, `unflag`, `move`, `archive`, `trash`, `new`, `reply`, `forward` | Sending is `new`/`reply`/`forward` inside this domain; there is no separate `send` tool and no alias for the removed one. |
| `folders` | `list`, `status` | `status` reads IMAP STATUS for exactly one mailbox and returns `messages`, `unseen`, `uid_next`. |
| `attachments` | `list`, `download` | Filenames are case-sensitive; `download` returns base64 content, capped at 25 MB per provider. |
| `config` | `status`, `setup_status`, `setup_start`, `setup_reset`, `setup_complete`, `set`, `cache_clear` | `set` returns `ok: false` (email has no runtime settings); `cache_clear` drops the IMAP sent/archive folder caches and the OAuth token cache. |
| `help` | one tool at a time via `tool_name` | Returns the Markdown topic from `src/docs/`. |

Bounds that matter operationally: `search` defaults to `limit` 20 and treats plain text as a subject search; `read` returns a bounded preview (4000 characters by default, `max_chars` 1-100000, `full`/`preview: false` for the whole body) with an explicit truncation marker and `body_truncated` / `body_char_count` fields; outbound attachments are capped at 10 files and 25 MB decoded total.

MCP resources are the per-tool documentation in `src/docs/`: `email://docs/{messages,folders,attachments,config,help}`.

`registerTools(server, accounts)` keeps one mutable account list per process, resolved from the environment at startup. A call made while that list is empty and the credential state is `configured` reloads it once (which is how credentials saved after startup are picked up). Tokens saved by `email auth` are re-read per call, but a mailbox added to `EMAIL_CREDENTIALS` after startup needs a restart.

### CLI surface

`email <tool> <action> [--flag <value>]... [--json]` runs the same handler the MCP tool runs. Flags are derived from the tool's own JSON Schema, so the CLI cannot accept an argument the tool does not take; output is the tool's exact envelope with `--json`, readable text otherwise, one stderr line and exit 1 on failure. `config-tool` is the CLI name of the `config` MCP tool, because the bare `email config` command is the operator command for the stored credential file.

Operator commands come from hull's `buildCli` plus this repository's two: `auth`, `logout`, `config status` / `config delete --yes`, `status`, `doctor`, `token hash`. `email --help` lists tool subcommands and operator commands as separate groups.

## Build and verify

- Node.js >= 24.22.2 (see `engines`); Bun for the toolchain, uv plus Python 3.13 for the session hook and the provider acceptance harness.
- Install: `bun install --frozen-lockfile`
- Check (Biome + type check): `bun run check`
- Tests: `bun run test`; with coverage: `bun run test -- --coverage`
- Build: `bun run build` (produces `build/` and `bin/cli.mjs`)
- Session hook tests: `uv run --with pytest==9.0.3 python -m pytest hooks/tests -q`
- Provider acceptance harness: `bun run provider:accept:lint` and `bun run provider:accept:test` (Python harness with its own 95% coverage floor)
- Live tests: `bun run test:full` against `tests/live/vitest.live.config.ts`; these need real mailbox credentials and are excluded from the default run.

CI is the authoritative check: `ci.yml` runs the PR-title conventional-commit gate, the session-hook tests, `bun run check`, the provider acceptance lint and test, the build, a Docker stdio-target build on Ubuntu, and the covered test run on Ubuntu, Windows, and macOS, plus `verify_readme_sync.py` and dependency review. Local commands are source evidence only.

Smoke without a mailbox: `email config-tool status --json` and `email help messages` reach the same handlers the MCP tools use and need no credentials. A representative live check must read a real message (`email messages search --query UNREAD --limit 5 --json`); a credential-status answer only proves startup.

## Configuration and credentials

| Variable | Required | Meaning |
|---|---|---|
| `EMAIL_CREDENTIALS` | stdio (or the `EMAIL_USER` pair) | one account as `email:app-password`, several comma-separated, or `email:password:imap_host[:imap_port]` for a custom host |
| `EMAIL_USER` + `EMAIL_APP_PASSWORD` | alternative | single-account pair, merged into `EMAIL_CREDENTIALS` at boot |
| `EMAIL_DATA_DIR` | no | base directory for this server's own files (default: the home directory) |
| `TRANSPORT_MODE` / `MCP_TRANSPORT` | no | set to `http` for the HTTP transport (or pass `--http`) |
| `HOST` | no (HTTP) | bind address, `0.0.0.0` by default |
| `PORT` / `MCP_PORT` | no (HTTP) | listen port; `PORT` wins, then `MCP_PORT`, then `0` (OS-assigned) |
| `EMAIL_MCP_TOKEN_HASH` | HTTP off loopback | `scrypt$` hash of the shared bearer token, minted with `email token hash` |
| `OUTLOOK_CLIENT_ID` | no | overrides the bundled public Azure client (or `--client-id` on `auth`) |
| `OUTLOOK_TENANT` | no | Microsoft directory for both the device-code and refresh calls; `common` for work/school mailboxes |
| `OUTLOOK_SCOPES` | no | space-separated scopes; narrow it for a read-only deployment |
| `OUTLOOK_EXTRA_DOMAINS` | no | extra domains routed to OAuth instead of a password |
| `OUTLOOK_EMAIL` | no | fallback address when the device-code response omits it |

Credential resolution at startup, in order: `EMAIL_CREDENTIALS`; the `EMAIL_USER`/`EMAIL_APP_PASSWORD` pair; the encrypted `config.enc` left by an earlier install (read-only, through hull's store under the fixed key `better-email-mcp`); saved Outlook OAuth tokens; otherwise `awaiting_setup`. Multiple accounts are comma-separated in one `EMAIL_CREDENTIALS` value, and a tool call selects one with the `account` parameter -- an ambiguous or unknown account is an error with the configured addresses listed, never a silent fallback to the first account.

Outlook/Hotmail/Live accounts use the OAuth2 device-code flow: `email auth [outlook] <address>` prints a code and a Microsoft URL, then saves tokens to `<base>/.better-email-mcp/tokens.json` (mode 0600 on POSIX). `email logout [<address>]` clears one or all of them. Every other provider uses an app password in `EMAIL_CREDENTIALS`.

`EMAIL_DATA_DIR` replaces the base directory outright, which is how a container mounts one volume (`EMAIL_DATA_DIR=/data` puts tokens at `/data/.better-email-mcp/tokens.json`; the image also sets `HOME=/data`). A relative value is resolved under the home directory and must stay inside it; an absolute value is an explicit operator choice and is taken as-is; empty means "use the default". The directory keeps its pre-rename name so tokens written by earlier releases stay readable.

Never commit app passwords, bearer tokens, hashes, `tokens.json`, or mailbox transcripts. Do not use an external service as the source of truth for local development or verification.

## Transports and auth modes

- **stdio** (default): one process, one credential set from the environment (or the stored config/tokens), no listener. Most providers need nothing beyond an app password.
- **HTTP**: a single-user server. One shared bearer token, supplied only as its scrypt hash in `EMAIL_MCP_TOKEN_HASH`; clients send `Authorization: Bearer <token>`. With no hash the server serves unauthenticated on loopback bind only and refuses to start on any other bind address, so a container that binds `0.0.0.0` cannot come up without a token.
- Accounts are resolved once at startup from the same environment as stdio. HTTP adds authentication, not per-caller credential namespaces; whoever can reach the endpoint can act on every configured mailbox.

`docker-compose.http.yml` publishes the HTTP image on host loopback only; exposing it beyond the host is the operator's own TLS reverse proxy. Startup success is the listener plus a successful tool call, not the banner on stderr.

## Data and state

- Saved OAuth tokens: `<base>/.better-email-mcp/tokens.json` (`EMAIL_DATA_DIR` when set, else the home directory).
- Legacy encrypted config from earlier releases: read through hull's store under the fixed namespace `better-email-mcp`; the `config` tool's `setup_reset` clears it and resets the state to `awaiting_setup`.
- The operator `email config status` / `email config delete --yes` command reads and removes the per-plugin credential store slug (`better-email`), which is separate from the legacy namespace above. `email doctor` reports the same store directory.
- In-process caches only: the IMAP sent-folder and archive-folder path caches plus the OAuth token cache. `config`'s `cache_clear` drops all three and reports how many folder entries it removed; a restart drops them too. No mailbox content is persisted by the server, and IMAP state lives in the provider.
- Every message read is fetched live over IMAP; nothing is mirrored to disk.

## Release and rollback

Releases are dispatch-only. `.github/workflows/cd.yml` takes `release_type` (`beta` or `stable`) and never releases on a push. In order: the README/package/Registry metadata gate (`verify_readme_sync.py`), a dry run of `n24q02m/better-semantic-release` to learn the version it would publish, a guard that refuses to continue if that version already exists on npm, the real semantic-release run (version bump in `package.json` / `.claude-plugin/plugin.json` / `server.json`, changelog, tag, GitHub release), then npm publish, the one-time legacy-package release, a multi-arch Docker build (`linux/amd64`, `linux/arm64`) merged into a manifest for Docker Hub and GHCR, the MCP Registry publish, and a marketplace sync dispatch.

Verify a release as separate facts: exact source commit, workflow run and job conclusions, the version on the tag, the npm package metadata, the image digests behind the manifest, and the Registry entry. A tag or an uploaded asset alone is not runtime evidence. Beta and stable are two dispatches of the same pipeline; a merge never promotes by itself, and stable promotion is a separate decision from this handover.

Rollback is forward: revert or fix the source commit and dispatch the pipeline again with a version above every version ever published. Never re-dispatch a version that reached npm, and never hand-create or move tags. If a run fails after publication steps began, record the exact run and job ids and inspect provider state before retrying.

## Known limits

- HTTP mode is single-user: one bearer token, one credential set, no per-caller isolation. Do not offer one endpoint to mutually untrusting callers.
- `set` is a no-op; configuration is environment-driven. A mailbox added to `EMAIL_CREDENTIALS` after startup needs a restart, while tokens saved by `email auth` are re-read per call.
- App passwords are the supported path for most providers; Microsoft disabled basic auth for Exchange Online, so a work/school mailbox needs the OAuth flow plus `OUTLOOK_TENANT`/`OUTLOOK_EXTRA_DOMAINS`.
- Attachment transfer is bounded (10 files, 25 MB decoded outbound; 25 MB per provider inbound) and `download` returns base64 in the tool result rather than writing to disk.
- Token files are plain JSON with POSIX mode 0600; Windows does not enforce that mode.
- The legacy `@n24q02m/better-email-mcp` package receives one final release, then freezes. The repository, package, image, binary, and MCP Registry id are `email`; the registry entry published earlier as `io.github.n24q02m/better-email-mcp` stays frozen under that old name.
- The version line at the top of this file is a release snapshot, not a live value.

## Week-one operator checklist

1. Decide the transport (stdio or HTTP) and, for HTTP, which single principal the token represents.
2. Install with the documented command, then run `bun run check` and `bun run test`.
3. Supply credentials: `EMAIL_CREDENTIALS` (app password or custom-host form), or `email auth outlook <address>` for a Microsoft mailbox.
4. Exercise one representative read against a test mailbox (`email messages search --query UNREAD --limit 5 --json`), then one `folders list`.
5. For HTTP, mint the hash with `email token hash`, confirm the server refuses to start off loopback without it, and confirm a wrong token is rejected.
6. Review the exact CI run before merging, and the exact release run before using a beta artifact.

## Triage

- stdio exits asking for credentials: neither `EMAIL_CREDENTIALS` nor the `EMAIL_USER`/`EMAIL_APP_PASSWORD` pair is set and no stored config or token was found. Set one, or run `email auth outlook <address>`.
- HTTP exits on start: non-loopback bind without `EMAIL_MCP_TOKEN_HASH`. Mint the hash and pass the hash only.
- Login failures: distinguish a wrong app password, a provider that rejects basic auth (use the OAuth flow), and a mailbox that requires a custom host/port (`email:password:imap_host:imap_port`).
- `AADSTS7000012` on an Outlook refresh: the token was issued for a different directory. Set `OUTLOOK_TENANT` to the directory that owns the mailbox and sign in again.
- `ACCOUNT_NOT_FOUND` / `AMBIGUOUS_ACCOUNT`: the `account` filter did not resolve to exactly one configured address; the error lists what is configured.
- Truncated reads: expected. Raise `max_chars` (up to 100000) or pass `full`, and check `body_truncated` rather than assuming the preview is the whole message.
- Stale Outlook token: `email logout <address>` then `email auth outlook <address>`; rotating credentials does not fix a revoked consent.
