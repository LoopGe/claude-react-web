import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  // These are layout-timing probes, not a parallel E2E suite. One worker keeps
  // Chromium and the Vite transform cache quiet enough for frame-by-frame reads.
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5175',
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:client -- --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175/tests/browser/fixtures/bottom-card-exit.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
