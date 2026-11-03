import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'app-panel-reshow.spec.ts',
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5186',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx tests/browser/fixtures/app-panel-state-server.mjs',
      url: 'http://127.0.0.1:3467/api/sessions',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev:client -- --host 127.0.0.1 --port 5186 --strictPort',
      url: 'http://127.0.0.1:5186',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { CRW_PORT: '3467' },
    },
  ],
})
