import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './packages/stellar-signer/test/browser',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  use: { browserName: 'chromium', headless: true },
});
