import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const BASE_URL = `http://localhost:${PORT}`

/**
 * Print output is the product here, and there is no way to assert on it without
 * a real browser: the page count comes from OSMD's own pagination, and the
 * paper size comes from CSS the printer resolves. So the check builds the app,
 * serves it, and prints it to PDF exactly as a user would.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // vite build directly, not `npm run build`: that script re-runs typecheck,
    // which CI already ran as its own step.
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
