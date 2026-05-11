import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Server tests run in Node; client hook tests run in jsdom.
    // Use workspace-style overrides so both share one `vitest run`.
    environment: 'node',
    include: ['server/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    // SessionStore tests touch real fs; serialise to avoid tmp dir races.
    pool: 'forks',
    globals: false,
    environmentMatchGlobs: [
      // Any test under src/ runs in jsdom.
      ['src/**', 'jsdom'],
    ],
  },
})
