/**
 * `EMAIL_DATA_DIR` end-to-end over the real filesystem: the token store this
 * server writes must live under the override, not under `$HOME`.
 *
 * Separate from `oauth2.test.ts` on purpose -- that suite mocks `node:fs` and
 * `node:os`, so it can only see which paths were requested, not that the file
 * really lands there.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATA_DIR_ENV, DATA_DIR_NAME } from '../../data-dir.js'
import { _resetTokenCache, loadStoredTokens, saveTokens } from './oauth2.js'

const TOKENS = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1000, clientId: 'cid' }

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'email-data-dir-'))
  process.env[DATA_DIR_ENV] = dataDir
  _resetTokenCache()
})

afterEach(() => {
  delete process.env[DATA_DIR_ENV]
  _resetTokenCache()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('EMAIL_DATA_DIR', () => {
  it('writes tokens under the DATA_DIR override', async () => {
    await saveTokens('user@outlook.com', TOKENS)

    const file = join(dataDir, DATA_DIR_NAME, 'tokens.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf-8'))['user@outlook.com']).toEqual(TOKENS)
  })

  it('reads tokens back from the DATA_DIR override', async () => {
    const dir = join(dataDir, DATA_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ 'user@outlook.com': TOKENS }))

    expect(await loadStoredTokens('user@outlook.com')).toEqual(TOKENS)
  })
})
