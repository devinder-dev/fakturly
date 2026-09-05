// vitest.config.ts — unit tests for the frontend.
//
// Vitest rather than bun:test here: it shares Vite's config, so JSX, the
// Tailwind plugin and import.meta.env behave exactly as in the app, and
// Testing Library's jsdom environment is a one-line setting. The backend
// keeps bun:test because it has none of those needs.

import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // Playwright specs live in e2e/ and run in a real browser, not here.
      exclude: ['e2e/**', 'node_modules/**']
    }
  })
)
