# Folders Tool - Full Documentation

## Overview
List mailbox folders, or read targeted IMAP STATUS metadata for exactly one account and folder.

## Important
- Returns folder **names, paths, flags, and children**
- `status` is read-only and does not select or enumerate the mailbox
- Gmail uses labels (e.g. `[Gmail]/All Mail`, `[Gmail]/Trash`)
- Outlook uses standard folders (Inbox, Sent, Drafts, Archive, Junk)
- Folder paths are case-sensitive

## Actions

### list
List all folders for all accounts or a specific account.

```json
{"action": "list"}
```

```json
{"action": "list", "account": "user@gmail.com"}
```

### status

Read `MESSAGES`, `UNSEEN`, and `UIDNEXT` from IMAP STATUS for one exact mailbox. `folder` is required and the action never falls back to all accounts. `account` may be omitted while exactly one account is enabled; with several it must name one, and the rejection lists the accounts to choose from.

```json
{"action": "status", "account": "user@yahoo.com", "folder": "INBOX"}
```

```json
{
  "action": "status",
  "account_id": "user_yahoo_com",
  "account_email": "user@yahoo.com",
  "folder": "INBOX",
  "messages": 10025,
  "unseen": 17,
  "uid_next": 10026
}
```

## Parameters

- `action` - Action to perform (required): `list` or `status`
- `account` - Account email or ID (`status`: required only when more than one account is enabled)
- `folder` - Exact mailbox path (required only for `status`)

## Common Folder Names

### Gmail
- `INBOX`
- `[Gmail]/All Mail`
- `[Gmail]/Drafts`
- `[Gmail]/Important`
- `[Gmail]/Sent Mail`
- `[Gmail]/Spam`
- `[Gmail]/Starred`
- `[Gmail]/Trash`

### Outlook
- `Inbox`
- `Sent`
- `Drafts`
- `Archive`
- `Junk`
- `Deleted`
