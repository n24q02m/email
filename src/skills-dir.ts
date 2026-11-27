import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_PARENT_WALK = 4

/**
 * Locate the bundled `skills/` directory by walking up from `startDir`.
 * Handles execution from `src/`, `build/src/`, `build/src/transports/`, and `bin/`.
 */
export function resolveSkillsDir(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir
  for (let i = 0; i <= MAX_PARENT_WALK; i++) {
    const candidate = join(dir, 'skills')
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Skills directory not found from ${startDir}`)
}
