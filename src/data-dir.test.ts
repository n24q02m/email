import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DATA_DIR_ENV, DATA_DIR_NAME, DataDirEscapeError, resolveBaseDir, resolveDataDir } from './data-dir.js'

// Platform-neutral absolute home: `resolve` makes it absolute on Windows too.
const HOME = resolve('/', 'home', 'user')

describe('resolveDataDir', () => {
  it('resolves the default data dir under the home directory', () => {
    expect(resolveBaseDir({}, HOME)).toBe(HOME)
    expect(resolveDataDir({}, HOME)).toBe(join(HOME, DATA_DIR_NAME))
  })

  it('honors an absolute DATA_DIR override', () => {
    const override = resolve('/', 'srv', 'mail')
    expect(resolveDataDir({ [DATA_DIR_ENV]: override }, HOME)).toBe(join(override, DATA_DIR_NAME))
  })

  it('resolves a relative DATA_DIR override inside the base dir', () => {
    expect(resolveBaseDir({ [DATA_DIR_ENV]: 'state/mail' }, HOME)).toBe(join(HOME, 'state', 'mail'))
    expect(resolveDataDir({ [DATA_DIR_ENV]: './state/../state/mail' }, HOME)).toBe(
      join(HOME, 'state', 'mail', DATA_DIR_NAME)
    )
  })

  it('rejects a relative DATA_DIR override that escapes the base dir', () => {
    // Native separators, so the traversal is real on POSIX and on Windows; a
    // backslash path is only a traversal where the platform treats it as one.
    const hostile = ['..', '../..', '../../etc', 'state/../../..', join('..', '..', 'windows')]
    if (process.platform === 'win32') hostile.push('..\\..\\windows')

    for (const value of hostile) {
      expect(() => resolveDataDir({ [DATA_DIR_ENV]: value }, HOME), value).toThrow(DataDirEscapeError)
    }
  })

  it('rejects a DATA_DIR override containing a NUL byte', () => {
    expect(() => resolveDataDir({ [DATA_DIR_ENV]: `${HOME}\0evil` }, HOME)).toThrow(DataDirEscapeError)
  })

  it('falls back to the default when DATA_DIR is empty or whitespace', () => {
    expect(resolveDataDir({ [DATA_DIR_ENV]: '' }, HOME)).toBe(join(HOME, DATA_DIR_NAME))
    expect(resolveDataDir({ [DATA_DIR_ENV]: '   ' }, HOME)).toBe(join(HOME, DATA_DIR_NAME))
    expect(resolveDataDir({ [DATA_DIR_ENV]: undefined }, HOME)).toBe(join(HOME, DATA_DIR_NAME))
  })
})
