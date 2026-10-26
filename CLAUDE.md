# CLAUDE.md - email

Ten repo/npm/image: `n24q02m/email` / `@n24q02m/email` / `n24q02m/email` (truoc day la `better-email-mcp`). CON GIU ten cu co chu dich: registry id `io.github.n24q02m/better-email-mcp`, bin alias `better-email-mcp`, data dir `~/.better-email-mcp` (PerPluginStore slug `better-email` + Outlook `tokens.json`), config namespace `better-email-mcp` (legacy `config.enc` doc qua hull `resolveConfig`), skret path `/better-email-mcp/prod`.

MCP Server cho Email (IMAP/SMTP). TypeScript, Node.js >= 24, bun, ESM.
4 composite tools (messages, folders, attachments, config; outbound new/reply/forward under messages) plus help. Multi-account, App Passwords, auto-discovery.

## Commands

```bash
# Setup
bun install

# Lint & Type check
bun run check                    # biome check + tsc --noEmit
bun run type-check               # tsc --noEmit only

# Fix
bun run check:fix                # biome fix + type check

# Test
bun run test                     # vitest (--passWithNoTests)
bun run test:watch               # vitest watch
bun run test:coverage            # vitest --coverage
bun vitest run src/tools/helpers/errors.test.ts   # single file

# Build & Dev
bun run build                    # tsc --build tsconfig.build.json + esbuild CLI
bun run dev                      # tsx watch dev server

# Docker
bun run docker:build
bun run docker:run

# Mise shortcuts
mise run setup     # full dev setup
mise run lint      # bun run check
mise run test      # bun run test
mise run fix       # bun run check:fix
```

## Cau truc thu muc

```
src/
  init-server.ts                 # Entry point, env validation
  credential-state.ts            # Single-user / stdio credential resolution from env
  auth/                          # Outlook device-code OAuth (`email auth outlook <address>`)
    outlook-device-code.ts       # Microsoft device-code OAuth flow
  transports/
    http.ts                      # Single-user HTTP transport: hull runHttpServer + bearer token hash (EMAIL_MCP_TOKEN_HASH)
  docs/                          # Markdown docs phuc vu qua MCP resources
  tools/
    registry.ts                  # Tool registration + routing
    composite/                   # Public domains: messages, folders, attachments, config; internal outbound helper: send.ts
    helpers/                     # errors, config, html-utils, imap-client, smtp-client
```

## Env vars

- **stdio mode** (default): `EMAIL_CREDENTIALS` (bat buoc). Format: `user@gmail.com:app-password`
  - Multi-account: `user1@gmail.com:pass1,user2@outlook.com:pass2`
  - Custom IMAP host: `user@custom.com:password:imap.custom.com`
  - Custom IMAP host + port: `user@custom.com:password:imap.custom.com:1993`
  - Local IMAP proxy: `user@custom.com:password:localhost:1993` (`localhost` accepted as host; per-account port)
- **http mode** (opt-in via `--http`, `MCP_TRANSPORT=http`, or `TRANSPORT_MODE=http`): bearer token from `EMAIL_MCP_TOKEN_HASH` (scrypt hash; mint with `printf '%s' "$TOKEN" | email token hash`, token read from stdin, never argv). Required when bound to a non-loopback host; `{mode:'no-auth'}` only on loopback. Self-host qua `docker-compose.http.yml` (volume `/data`, publish loopback `127.0.0.1:8082`). Creds: `EMAIL_CREDENTIALS` env; Outlook tokens `~/.better-email-mcp/tokens.json`.
- `PORT` (default `0` = OS-assigned random port), `HOST` (optional bind address)
- `OUTLOOK_CLIENT_ID` -- tu chon, cho self-hosted OAuth2 client. CLI `auth --client-id=<id>` override env var (flag thang env, xem `auth-cli.ts:parseArgs`)
- `OUTLOOK_TENANT` -- tu chon, tenant cho CA device-code LAN token refresh (`oauth2.ts:getOutlookTenant`). Default `consumers` (stdio/CLI) va `common` (http delegated, `auth/outlook-device-code.ts`). Work/school (Entra ID) can `common` hoac tenant GUID -- refresh token cua work/school danh vao `/consumers` se loi `AADSTS7000012`
- `OUTLOOK_SCOPES` -- tu chon, danh sach scope cach nhau bang space (`oauth2.ts:getOutlookScopes`). Dung khi grant duoc consent hep hon default (vd IMAP-only, khong SMTP)
- `OUTLOOK_EXTRA_DOMAINS` -- tu chon, domain cach nhau bang dau phay, gop them vao `OUTLOOK_DOMAINS` de mailbox M365 tren custom domain di duong OAuth thay vi doi password

## Code conventions

- Biome: 2 spaces, 120 line width, single quotes, semicolons as needed, trailing commas none
- Import: `import type` rieng, `.js` extension bat buoc, `node:` prefix cho builtins
- tsconfig: `strict: true`, target es2021, module es2022, moduleResolution Bundler
- Error: `EmailMCPError` + `withErrorHandling()` HOF. `enhanceError()` + `suggestFixes()`.
- Error details duoc sanitize de tranh lo secrets/passwords.
- Test files co-located: `errors.test.ts` canh `errors.ts`
- `noExplicitAny`: off (email API responses dung `any`)

## CD Pipeline

PSR v10 (workflow_dispatch) -> npm + Docker (amd64+arm64) + GHCR + MCP Registry.

## Luu y

- Outlook/Hotmail/Live dung OAuth2 tu dong (Device Code flow). Token luu tai `~/.better-email-mcp/tokens.json`.
- Gmail, Yahoo, iCloud: dung App Passwords, KHONG phai password thuong.
- Account resolution: filter theo email, id, hoac partial match.
- Composite tool signature: `async function toolName(accounts: AccountConfig[], input: TypedInput): Promise<any>`
- 3-tier token optimization: Tier 1 (compact), Tier 2 (help tool), Tier 3 (MCP Resources).
- Pre-commit: biome check --write, tsc --noEmit, bun run test.
- Secrets: skret SSM namespace `/better-email-mcp/prod` (region `ap-southeast-1`)

## Modes

Two transports, selected in `init-server.ts:52-53`. There is no `MCP_MODE` env var; the old `remote-relay` / `local-relay` distinction was removed (see `transports/http.ts:5`).

- **stdio (default)**: MCP SDK `StdioServerTransport` directly. Reads credentials from `EMAIL_CREDENTIALS` OR `EMAIL_USER` + `EMAIL_APP_PASSWORD`. Outlook accounts use an App Password in this mode.
- **http (opt-in, self-hosted)**: enabled via `--http`, `MCP_TRANSPORT=http`, or `TRANSPORT_MODE=http`. Single user: one shared bearer token (`EMAIL_MCP_TOKEN_HASH`, hull `runHttpServer` auth mode `token`). Accounts come from `EMAIL_CREDENTIALS` or `email auth outlook <address>`; there is no relay form and no per-user store. The project no longer operates a public n24q02m HTTP deployment.

## Known bugs (phat hien 2026-04-18 E2E)

1. **Config storage path**: legacy `config.enc` from earlier releases lives in the platformdirs `mcp` config dir (`$APPDATA\mcp\Config\config.enc` on Windows). It is read through hull `resolveConfig` only; this server does not write it. When debugging, clear that path and `~/.better-email-mcp/tokens.json` to reset state.

2. **Outlook token identity**: resolved in the current source. `saveOutlookTokens` resolves the key in this order: token `email`, `OUTLOOK_EMAIL`, token `sub`, decoded `id_token` subject, then the deterministic `outlook-device-code` fallback. `oauth2.test.ts` covers each branch. Keep `OUTLOOK_EMAIL` as an explicit workaround only when the provider response has no usable identity claim; do not treat the old "long-term fix" note as open work.

## Tests

- Unit and integration: `bun run test` (vitest). The full suite runs in GitHub Actions.
- Live protocol checks: `tests/live/` (manual; needs real provider credentials).

The mcp-core e2e matrix and relay-form drivers were removed with the relay; this repo has no T2 relay-form configs.
