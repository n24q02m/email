# Messages Tool - Full Documentation

## Overview
Email messages: search, read, mark_read, mark_unread, flag, unflag, move, archive, trash, new, reply, forward.

## Important
- **read** returns a bounded body preview by default (4000 characters, HTML stripped for LLM token savings); the truncated text ends with an explicit `[Truncated: showing N of M characters ...]` marker and the response adds `body_truncated`, `body_char_count`, `body_limit`, and `body_truncation_hint`
- Pass `full: true` (or `preview: false`) for the complete body; `preview: <number>` or `max_chars` sets the budget (1-100000, default 4000)
- **UIDs are per-account and per-folder** - always specify account for modify operations
- Query language supports compound filters: `UNREAD SINCE 2024-01-01`
- **reply** automatically sets In-Reply-To and References headers for threading
- **forward** includes the original email body with a separator
- Outbound bodies support plain text or HTML; do not mix both

## Actions

### search
Search emails across all or filtered accounts.
```json
{"action": "search", "query": "UNREAD", "folder": "INBOX", "limit": 20}
```
```json
{"action": "search", "query": "UNREAD SINCE 2024-06-01", "account": "user@gmail.com"}
```
```json
{"action": "search", "query": "FROM boss@company.com", "limit": 5}
```

Query shortcuts:
- `UNREAD` / `UNSEEN` - unread emails
- `READ` / `SEEN` - read emails
- `FLAGGED` / `STARRED` - flagged emails
- `ALL` / `*` - all emails
- `SINCE YYYY-MM-DD` - emails after date
- `FROM email` - emails from sender
- `SUBJECT text` - emails matching subject
- `UNREAD SINCE YYYY-MM-DD` - compound filter
- `UNREAD FROM email` - compound filter
- Any other text is treated as subject search

### read
Read a single email by UID. Reads are bounded by default (4000 characters); pass `full: true` for the complete clean body.
```json
{"action": "read", "account": "user@gmail.com", "uid": 12345, "folder": "INBOX"}
```
```json
{"action": "read", "account": "user@gmail.com", "uid": 12345, "max_chars": 8000}
```
Bounded responses retain the message metadata and return:
- a `body_text` ending in `[Truncated: showing <limit> of <total> characters (<omitted> omitted). Pass full:true for the complete body.]` when the body exceeded the limit
- `body_truncated` - whether the body was shortened
- `body_char_count` - full body length in characters
- `body_limit` - applied preview limit
- `body_truncation_hint` - present only when truncated, naming the full length and how to fetch it

### mark_read
```json
{"action": "mark_read", "account": "user@gmail.com", "uids": [123, 456, 789]}
```

### mark_unread
```json
{"action": "mark_unread", "account": "user@gmail.com", "uid": 123}
```

### flag
Star/flag emails.
```json
{"action": "flag", "account": "user@gmail.com", "uids": [123, 456]}
```

### unflag
Remove star/flag from emails.
```json
{"action": "unflag", "account": "user@gmail.com", "uid": 123}
```

### move
Move emails to another folder.
```json
{"action": "move", "account": "user@gmail.com", "uids": [123], "destination": "[Gmail]/Important"}
```

### archive
Archive emails. The archive folder is detected from the folder list (a folder whose name contains Archive or All Mail, or that carries the `\Archive` or `\All` flag); when none is found (or listing fails) it falls back to `[Gmail]/All Mail` on Gmail and `Archive` elsewhere. If the server rejects the move (for example, no archive folder exists), the call fails with "The server rejected moving N message(s)" and the messages stay where they were; use `move` with an explicit `destination` instead. `move` and the flag actions fail the same way when the server rejects them.
```json
{"action": "archive", "account": "user@gmail.com", "uids": [123, 456]}
```

### trash
Move emails to the account's Trash folder (the folder flagged `\Trash`, else one named Trash, Deleted Items, Deleted Messages, Deleted or Bin). Nothing is deleted permanently: empty the Trash from the mail client. The result reports `trash_folder`. The call fails when the account has no Trash folder, when `folder` already is the Trash, or when the server rejects the move.
```json
{"action": "trash", "account": "user@gmail.com", "uid": 123}
```

### new
Send a new email via SMTP.
```json
{"action": "new", "account": "user@gmail.com", "to": "recipient@example.com", "subject": "Hello", "body": "Hi there!"}
```
```json
{"action": "new", "account": "user@gmail.com", "to": "a@example.com", "subject": "Update", "body": "See details.", "cc": "b@example.com", "bcc": "c@example.com"}
```
```json
{"action": "new", "account": "user@gmail.com", "to": "a@example.com", "subject": "Proposal", "body": "Draft for review.", "draft": true}
```
Send as an alias of the account (see [Sender aliases](#sender-aliases)); the alias alone picks the account:
```json
{"action": "new", "from": "Support <support@example.com>", "to": "a@example.com", "subject": "Hello", "body": "Hi there!"}
```

### reply
Reply to an email. Reads the original email to set threading headers and auto-derives the recipient when `to` is omitted.
```json
{"action": "reply", "account": "user@gmail.com", "body": "Thanks!", "uid": 12345}
```
```json
{"action": "reply", "account": "user@gmail.com", "to": "sender@example.com", "subject": "Re: Custom subject", "body": "Got it.", "uid": 12345, "folder": "INBOX"}
```

### forward
Forward an email. The original body is appended with a separator.
```json
{"action": "forward", "account": "user@gmail.com", "to": "colleague@example.com", "body": "FYI, see below.", "uid": 12345}
```

- `action` - Action to perform (required); `search` fans out over the enabled accounts and one failing account does not hide the others' results
- `account` - Account email filter (optional for search; required for modify and send when more than one account is configured)
- `query` - Search query string (default: UNSEEN)
- `folder` - Mailbox folder (default: INBOX)
- `limit` - Max search results (default: 20)
- `uid` - Single email UID
- `preview` - Bounded body preview for read (default: true; `false` reads the full body, a number sets the budget)
- `max_chars` - Preview body limit, integer 1-100000 (default: 4000)
- `full` - Return the complete message body, bypassing the default preview
- `uids` - Multiple email UIDs for batch operations
- `destination` - Target folder for move action
- `to` - Recipient email address (required for new/forward, optional for reply)
- `subject` - Email subject (required for new, optional for reply/forward)
- `body` - Email body (required for new/reply/forward)
- `cc` - CC recipients (comma-separated, optional)
- `bcc` - BCC recipients (comma-separated, optional)
- `attachments` - Base64 file attachments, max 10 files and 25MB decoded total
- `draft` - Save new/reply/forward to the Drafts folder instead of sending (optional)
- `from` - Sender for new/reply/forward: the account email or one of its `aliases`, optionally `Name <address>` (optional). Without `account`, the account that owns the address sends it. A reply without `from` answers from the alias the original was addressed to

## Outbound response and provider behavior

- `saved_to_sent` reports whether the sent message was saved to the Sent folder via IMAP APPEND.
- Gmail and Yahoo auto-save sent messages, so IMAP APPEND is skipped. iCloud does not, so it is appended like any other provider.
- Outlook, Zoho, Fastmail, and other providers use best-effort IMAP APPEND.
- Outlook.com/Hotmail/Live accounts use OAuth2 automatically; the first use may return a sign-in link and code, and tokens refresh silently.
- Reply subjects are prefixed with `Re:` when needed; forward subjects are prefixed with `Fwd:` when needed.
- Bodies support basic markdown such as headings, lists, and bold text.

### Drafts

With `draft: true`, `new`, `reply` and `forward` compose the message exactly as they would send it (threading headers, quoted original, attachments) but append it to the account's Drafts folder (flags `\Draft`, `\Seen`) instead. The result carries `sent: false`, `saved_to_drafts: true` and `drafts_folder`. If the draft cannot be saved the call fails; nothing is sent.

### Sender aliases

One mailbox often receives mail for several addresses (iCloud+ custom domains, Gmail "Send mail as", Fastmail aliases). List them under the account in `accounts.toml`:

```toml
[accounts.icloud]
email = "me@icloud.com"
password = "app-specific-password"
aliases = ["hello@example.com", "support@example.com"]
```

The login stays `email`; an alias only changes the From header and the SMTP envelope sender, so the provider must allow sending as that address. Search and read already cover mail sent to every alias, since it lands in the same mailbox (`TO hello@example.com` narrows a search to one address). Any other `from` is refused with an error saying the account cannot send as that address, and an alias can belong to only one account.

### Draft-only mode

For agents that read untrusted mail, run the server with `EMAIL_MCP_DRAFT_ONLY=1`. Every `new`, `reply` and `forward` becomes a draft, whatever `draft` says, so the user reviews and sends it. `move`, `archive` and `trash` (and `config` `setup_reset`) are removed from the advertised tool schema and return a `DRAFT_ONLY` error if called anyway. Search, read and flag changes still work.
