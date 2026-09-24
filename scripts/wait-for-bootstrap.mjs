import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const urlText = String(process.argv[2] || '').trim();

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(Math.max(Math.floor(number), minimum), maximum)
    : fallback;
}

const timeoutMs = bounded(process.env.R433_BOOTSTRAP_TIMEOUT_MS, 30000, 1000, 30000);
const probeTimeoutMs = bounded(process.env.R433_BOOTSTRAP_PROBE_TIMEOUT_MS, 2500, 250, 5000);
const retryDelayMs = bounded(process.env.R433_BOOTSTRAP_RETRY_MS, 250, 50, 1000);

if (!urlText) {
  console.error('bootstrap URL is required');
  process.exit(2);
}

let target;
try {
  target = new URL(urlText);
} catch (error) {
  console.error(`invalid bootstrap URL: ${error.message || error}`);
  process.exit(2);
}

function probe() {
  return new Promise((resolve) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(target, { timeout: probeTimeoutMs }, response => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 400);
    });
    request.once('error', () => resolve(false));
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  if (await probe()) process.exit(0);
  await delay(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())));
}

console.error(`bootstrap endpoint was not ready within ${timeoutMs}ms: ${urlText}`);
process.exit(1);
