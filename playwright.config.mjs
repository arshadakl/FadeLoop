import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: '**/*.pw.mjs', workers: 1, timeout: 30000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8789', browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
  webServer: process.env.FADELOOP_UI_EXTERNAL ? undefined : { command: 'node scripts/serve-ui-test.mjs', url: 'http://127.0.0.1:8789/health', reuseExistingServer: false, timeout: 30000 },
});
