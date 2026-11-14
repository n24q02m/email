import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['build/**', 'node_modules/**', 'bin/**', 'tests/live/**', 'tests/e2e*'],
    // The accounts file wins over every env credential, and its default path is
    // ~/.email/accounts.toml. Off by default, so a developer's own mailboxes never
    // decide a result; tests that cover the file opt back in with vi.stubEnv.
    env: { EMAIL_ACCOUNTS_FILE: 'off' },
    coverage: {
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'build/', 'bin/'],
      thresholds: { statements: 95, lines: 95, functions: 95, branches: 90 }
    }
  }
})
