import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test/browser',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:4197',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.FARM_E2E_CHROMIUM_PATH || undefined },
  },
  projects: [
    { name: 'mobile-light', use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium', colorScheme: 'light' } },
    { name: 'mobile-dark', use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium', colorScheme: 'dark' } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4197 --strictPort',
    url: 'http://127.0.0.1:4197/test/browser/accounts.html',
    reuseExistingServer: false,
  },
})
