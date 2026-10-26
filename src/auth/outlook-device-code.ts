/**
 * Microsoft Outlook OAuth 2.0 Device Code configuration.
 *
 * Scopes requested:
 *   - offline_access                                   -> refresh_token
 *   - https://outlook.office.com/IMAP.AccessAsUser.All -> IMAP mailbox
 *   - https://outlook.office.com/SMTP.Send             -> SMTP send
 *
 * Tenant and scopes are overridable (`OUTLOOK_TENANT`, `OUTLOOK_SCOPES`) so an
 * M365 work/school directory can be targeted; the defaults here are unchanged
 * (`common`, full IMAP+SMTP grant).
 */
import { getOutlookScopes, getOutlookTenant } from '../tools/helpers/oauth2.js'

export interface OutlookDeviceCodeConfig {
  deviceAuthUrl: string
  tokenUrl: string
  clientId: string
  scopes: string[]
  pollIntervalMs: number
}

const UPSTREAM_DEFAULT_TENANT = 'common'
const UPSTREAM_DEFAULT_SCOPES = [
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send'
]

export function buildOutlookUpstream(opts: { clientId: string }): OutlookDeviceCodeConfig {
  const authBase = `https://login.microsoftonline.com/${getOutlookTenant(UPSTREAM_DEFAULT_TENANT)}/oauth2/v2.0`
  return {
    deviceAuthUrl: `${authBase}/devicecode`,
    tokenUrl: `${authBase}/token`,
    clientId: opts.clientId,
    scopes: getOutlookScopes(UPSTREAM_DEFAULT_SCOPES),
    pollIntervalMs: 5000
  }
}
