import { defineConfig } from '@playwright/test'

// Dedicated harness for the NATIVE prompt-suggestion E2E. Kept SEPARATE from
// playwright.app.config.ts on purpose: that suite's fixture registers a fake
// `claude` provider, while this one registers the REAL NativeProvider (scripted
// `_testStream`) on its own port pair. A separate config means zero change to the
// existing harness and no second concurrent Vite dev server when the app suite
// runs (the two would share node_modules/.vite).
//
// Run:
//   npx playwright test --config playwright.native-suggestion.config.ts
export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['native-prompt-suggestion.spec.ts'],
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5187',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx tests/browser/fixtures/native-suggestion-server.mjs',
      url: 'http://127.0.0.1:3468/api/sessions',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev:client -- --host 127.0.0.1 --port 5187 --strictPort',
      url: 'http://127.0.0.1:5187',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { CRW_PORT: '3468' },
    },
  ],
})