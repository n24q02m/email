import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSkillsDir } from './skills-dir.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveSkillsDir', () => {
  it('finds bundled skills directory from default location', () => {
    const dir = resolveSkillsDir()
    expect(dir.endsWith('skills')).toBe(true)
  })

  it('walks up from nested subdirectories like src/transports', () => {
    const dir = resolveSkillsDir(join(process.cwd(), 'src', 'transports'))
    expect(dir).toBe(join(process.cwd(), 'skills'))
  })

  it('throws when no skills directory exists within walk limit', () => {
    const isolated = mkdtempSync(join(tmpdir(), 'no-skills-dir-'))
    tempDirs.push(isolated)
    expect(() => resolveSkillsDir(isolated)).toThrow('Skills directory not found')
  })
})
