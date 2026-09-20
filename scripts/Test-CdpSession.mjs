import { chromium } from 'playwright-core';

const port = Number(process.argv[2] || 9333);
const timeoutMs = Number(process.argv[3] || 6000);
const endpoint = `http://127.0.0.1:${port}`;

try {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
  if (!browser.contexts().length) {
    throw new Error('CDP connected without a browser context');
  }
  process.stdout.write('CDP_SESSION_OK\n');
  process.exit(0);
} catch (error) {
  process.stderr.write(`CDP_SESSION_FAILED: ${error?.message || error}\n`);
  process.exit(1);
}
