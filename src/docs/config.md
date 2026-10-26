# Config Tool

Manage email credential setup and runtime configuration.

### Description
This tool reports the status of your email credentials, explains how to set them up, resets saved configuration, re-checks credential state after external changes, and manages runtime caches. Credentials come from environment variables, the legacy encrypted config (read-only), or saved Outlook OAuth tokens. There is no web credential form; set credentials with env vars or the `email auth outlook <address>` CLI command.

### Actions

#### 1. status
Check current credential state and the configured accounts.
```json
{
  "action": "status"
}
```

#### 2. setup_status
Credential state only (`state`), without the `accounts` list `status` also returns.
```json
{
  "action": "setup_status"
}
```

#### 3. setup_start
Explain how to configure credentials. Returns a `message` and the current `state`. No URL is returned.
```json
{
  "action": "setup_start"
}
```

#### 4. setup_reset
Delete the saved config and reset to the `awaiting_setup` state.
```json
{
  "action": "setup_reset"
}
```

#### 5. setup_complete
Re-check credential state after external config changes (for example after editing env vars or running `email auth outlook`). Returns `previous_state`, `state`, and the `accounts` list.
```json
{
  "action": "setup_complete"
}
```

#### 6. set
Update a runtime setting. Email MCP has no runtime settings; always returns `ok: false`.
```json
{
  "action": "set"
}
```

#### 7. cache_clear
Clear all in-memory caches (sent folder paths, archive folder paths, OAuth token cache).
Returns the number of cache entries cleared.
```json
{
  "action": "cache_clear"
}
```
