// playwright.config.ts — end-to-end tests in a real browser.
//
// Two servers are started: the API (in demo mode, on its own port) and the
// built frontend via `vite preview`. Both are reused when already running,
// so the suite works against a developer's own dev servers as well as in CI.
//
// The database behind the API must hold the demo dataset. CI seeds it; a
// developer runs `bun run seed:demo` in backend/ first.

import { defineConfig, devices } from '@playwright/test'

const API_PORT = Number(process.env.E2E_API_PORT ?? 3100)
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173)

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Tests share one database, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'sv-SE'
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // FRONTEND_URL is the CORS allowlist: the API must accept the preview
      // server's origin, or every request from the test browser is refused
      // before a handler runs — and the symptom is "no demo buttons".
      command: `cd ../backend && DEMO_MODE=true PORT=${API_PORT} FRONTEND_URL=http://localhost:${WEB_PORT} bun src/server.ts`,
      url: `http://localhost:${API_PORT}/health/ready`,
      reuseExistingServer: true,
      timeout: 60_000
    },
    {
      command: `VITE_API_URL=http://localhost:${API_PORT} bun run build && bun x vite preview --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: true,
      timeout: 120_000
    }
  ]
})
