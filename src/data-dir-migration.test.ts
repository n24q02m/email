import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATA_DIR_ENV, DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, LEGACY_STORE_PLUGIN, STORE_PLUGIN } from './data-dir.js'
import { migrateLegacyData, resetStoreMigrationForTesting, StoreMigrationError } from './data-dir-migration.js'

// The two on-disk layouts the rename moves state between. Spelled out rather than
// derived, so a silent rename in either direction fails here.
const OLD_DIR = '.better-email-mcp'
const NEW_DIR = '.email'

const tokensFile = (email: string, refreshToken: string) =>
  JSON.stringify({ [email]: { accessToken: 'at', refreshToken, expiresAt: 1000, clientId: 'cid' } })

describe('migrateLegacyData', () => {
  let home: string
  let savedDataDir: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'email-migration-'))
    savedDataDir = process.env[DATA_DIR_ENV]
    process.env[DATA_DIR_ENV] = home
    // hull resolves the credential blob from one process-wide home; point it at the
    // same temp dir so nothing here can touch the real ~/.email.
    setHomeDirForTesting(home)
    resetStoreMigrationForTesting()
  })

  afterEach(() => {
    resetStoreMigrationForTesting()
    setHomeDirForTesting(null)
    if (savedDataDir === undefined) delete process.env[DATA_DIR_ENV]
    else process.env[DATA_DIR_ENV] = savedDataDir
    rmSync(home, { recursive: true, force: true })
  })

  it('pins the directory pair the migration exists for', () => {
    expect(STORE_PLUGIN).toBe('email')
    expect(LEGACY_STORE_PLUGIN).toBe('better-email')
    expect(DATA_DIR_NAME).toBe(NEW_DIR)
    expect(LEGACY_DATA_DIR_NAME).toBe(OLD_DIR)
  })

  // Branch 1: only the pre-rename layout exists -> both kinds of state still resolve.
  it('copies a pre-rename token file and credential blob forward', async () => {
    mkdirSync(join(home, OLD_DIR), { recursive: true })
    writeFileSync(join(home, OLD_DIR, 'tokens.json'), tokensFile('user@outlook.com', 'old-rt'))
    await new PerPluginStore(LEGACY_STORE_PLUGIN).save({ EMAIL_CREDENTIALS: 'user@example.com:app-password' })
    expect(existsSync(join(home, NEW_DIR))).toBe(false)

    const report = await migrateLegacyData()

    expect(report.migrated).toEqual([
      { source: join(home, OLD_DIR, 'tokens.json'), target: join(home, NEW_DIR, 'tokens.json') },
      { source: join(home, '.better-email'), target: join(home, NEW_DIR, 'config.json') }
    ])
    // Byte-identical copy, 0600 on POSIX, and the original still there.
    expect(readFileSync(join(home, NEW_DIR, 'tokens.json'), 'utf-8')).toBe(
      readFileSync(join(home, OLD_DIR, 'tokens.json'), 'utf-8')
    )
    if (process.platform !== 'win32') {
      expect(statSync(join(home, NEW_DIR, 'tokens.json')).mode & 0o777).toBe(0o600)
    }
    expect(existsSync(join(home, OLD_DIR, 'tokens.json'))).toBe(true)
    expect(await new PerPluginStore(STORE_PLUGIN).load()).toEqual({
      EMAIL_CREDENTIALS: 'user@example.com:app-password'
    })
    expect(await new PerPluginStore(LEGACY_STORE_PLUGIN).load()).toEqual({
      EMAIL_CREDENTIALS: 'user@example.com:app-password'
    })
  })

  // Branch 2: only the post-rename layout exists -> untouched.
  it('leaves a current layout untouched when there is nothing older', async () => {
    mkdirSync(join(home, NEW_DIR), { recursive: true })
    writeFileSync(join(home, NEW_DIR, 'tokens.json'), tokensFile('user@outlook.com', 'current-rt'))
    await new PerPluginStore(STORE_PLUGIN).save({ EMAIL_CREDENTIALS: 'current@example.com:app-password' })

    const report = await migrateLegacyData()

    expect(report.migrated).toEqual([])
    expect(report.kept).toEqual([join(home, NEW_DIR, 'tokens.json'), join(home, NEW_DIR, 'config.json')])
    expect(existsSync(join(home, OLD_DIR))).toBe(false)
    expect(existsSync(join(home, '.better-email'))).toBe(false)
    expect(readFileSync(join(home, NEW_DIR, 'tokens.json'), 'utf-8')).toBe(tokensFile('user@outlook.com', 'current-rt'))
  })

  // Branch 3: both exist -> the current layout wins and the old one survives intact.
  it('keeps the current token file and credential blob when pre-rename copies exist', async () => {
    const oldTokens = tokensFile('user@outlook.com', 'old-rt')
    const currentTokens = tokensFile('user@outlook.com', 'current-rt')
    mkdirSync(join(home, OLD_DIR), { recursive: true })
    mkdirSync(join(home, NEW_DIR), { recursive: true })
    writeFileSync(join(home, OLD_DIR, 'tokens.json'), oldTokens)
    writeFileSync(join(home, NEW_DIR, 'tokens.json'), currentTokens)
    await new PerPluginStore(LEGACY_STORE_PLUGIN).save({ EMAIL_CREDENTIALS: 'old@example.com:app-password' })
    await new PerPluginStore(STORE_PLUGIN).save({ EMAIL_CREDENTIALS: 'current@example.com:app-password' })

    const report = await migrateLegacyData()

    expect(report.migrated).toEqual([])
    expect(report.kept).toHaveLength(2)
    expect(readFileSync(join(home, NEW_DIR, 'tokens.json'), 'utf-8')).toBe(currentTokens)
    expect(readFileSync(join(home, OLD_DIR, 'tokens.json'), 'utf-8')).toBe(oldTokens)
    expect(await new PerPluginStore(STORE_PLUGIN).load()).toEqual({
      EMAIL_CREDENTIALS: 'current@example.com:app-password'
    })
    expect(await new PerPluginStore(LEGACY_STORE_PLUGIN).load()).toEqual({
      EMAIL_CREDENTIALS: 'old@example.com:app-password'
    })
  })

  // Branch 4: an empty old directory is not a migration and must not create the
  // new one (an empty store reported as "configured" is its own bug).
  it('does nothing when the pre-rename directory holds no token file', async () => {
    mkdirSync(join(home, OLD_DIR), { recursive: true })

    const report = await migrateLegacyData()

    expect(report.migrated).toEqual([])
    expect(report.kept).toEqual([])
    expect(existsSync(join(home, NEW_DIR))).toBe(false)
  })

  // Branch 5a: an unreadable pre-rename token file is an error, never "not configured".
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable pre-rename token file instead of dropping it',
    async () => {
      mkdirSync(join(home, OLD_DIR), { recursive: true })
      const source = join(home, OLD_DIR, 'tokens.json')
      const content = tokensFile('user@outlook.com', 'secret-refresh-token')
      writeFileSync(source, content)
      chmodSync(source, 0o000)
      try {
        const failure = await migrateLegacyData().catch((error: unknown) => error)

        expect(failure).toBeInstanceOf(StoreMigrationError)
        expect((failure as StoreMigrationError).path).toBe(source)
        expect((failure as Error).message).toContain(source)
        expect((failure as Error).message).not.toContain('secret-refresh-token')
        expect(existsSync(join(home, NEW_DIR, 'tokens.json'))).toBe(false)
      } finally {
        chmodSync(source, 0o600)
      }
      expect(readFileSync(source, 'utf-8')).toBe(content)
    }
  )

  // Branch 5b (every platform): something that is not a token file is the same
  // class of broken install and gets the same clear failure.
  it('reports a pre-rename token path that is not a file', async () => {
    mkdirSync(join(home, OLD_DIR, 'tokens.json'), { recursive: true })

    const failure = await migrateLegacyData().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(StoreMigrationError)
    expect((failure as StoreMigrationError).path).toBe(join(home, OLD_DIR, 'tokens.json'))
    expect((failure as Error).message).toContain(join(home, OLD_DIR, 'tokens.json'))
    expect(existsSync(join(home, NEW_DIR))).toBe(false)
  })

  // Branch 5c: same contract on the credential-blob side.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable pre-rename credential store instead of dropping it',
    async () => {
      await new PerPluginStore(LEGACY_STORE_PLUGIN).save({ EMAIL_CREDENTIALS: 'user@example.com:app-password' })
      chmodSync(join(home, '.better-email'), 0o000)
      try {
        const failure = await migrateLegacyData().catch((error: unknown) => error)

        expect(failure).toBeInstanceOf(StoreMigrationError)
        expect((failure as StoreMigrationError).path).toBe(join(home, '.better-email'))
        expect((failure as Error).message).toContain(join(home, '.better-email'))
      } finally {
        chmodSync(join(home, '.better-email'), 0o700)
      }
      expect(existsSync(join(home, NEW_DIR, 'config.json'))).toBe(false)
    }
  )

  it('migrates once per process even when startup paths call it twice', async () => {
    mkdirSync(join(home, OLD_DIR), { recursive: true })
    writeFileSync(join(home, OLD_DIR, 'tokens.json'), tokensFile('user@outlook.com', 'rt'))

    const [first, second] = await Promise.all([migrateLegacyData(), migrateLegacyData()])

    expect(second).toBe(first)
    expect(first.migrated).toHaveLength(1)
  })
})
