# Attachments Tool - Full Documentation

## Overview
List and download email attachments.

## Important
- **list** returns metadata only (filename, content_type, size)
- **download** returns base64-encoded content
- Large attachments may consume significant tokens - check size before downloading
- `uid` is required for all actions; `account` may be omitted while exactly one account is enabled, and must name one of several

## Actions

### list
List all attachments for an email.
```json
{"action": "list", "account": "user@gmail.com", "uid": 12345}
```
```json
{"action": "list", "account": "user@gmail.com", "uid": 12345, "folder": "INBOX"}
```

### download
Download a specific attachment by filename. Returns base64-encoded content.
```json
{"action": "download", "account": "user@gmail.com", "uid": 12345, "filename": "report.pdf"}
```

## Parameters
- `action` - Action to perform (required): list, download
- `account` - Account email (required only when more than one account is enabled)
- `uid` - Email UID (required)
- `folder` - Mailbox folder (default: INBOX)
- `filename` - Attachment filename (required for download, case-insensitive)

## Response Fields

### list response
- `attachments[].filename` - Attachment filename
- `attachments[].content_type` - MIME type (e.g. application/pdf)
- `attachments[].size` - Size in bytes
- `attachments[].content_id` - Content-ID for inline attachments

### download response
- `filename` - Attachment filename
- `content_type` - MIME type
- `size` - Size in bytes
- `content_base64` - Base64-encoded file content
