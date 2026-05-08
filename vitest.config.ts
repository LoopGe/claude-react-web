import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    // SessionStore tests touch real fs; serialise to avoid tmp dir races.
    pool: 'forks',
    globals: false,
  },
})
