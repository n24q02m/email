import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/e2e.test.ts', 'tests/e2e-multi-account.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 300_000
  }
})
