import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watchdog = fs.readFileSync(path.join(ROOT, 'Watchdog.ps1'), 'utf8');
const startController = fs.readFileSync(path.join(ROOT, 'Start-Controller.ps1'), 'utf8');
const cdpProbe = fs.readFileSync(path.join(ROOT, 'scripts', 'Test-CdpSession.mjs'), 'utf8');

test('watchdog independently detects and repairs a dead Chrome CDP endpoint', () => {
  assert.match(watchdog, /function Test-CdpReady/);
  assert.match(watchdog, /127\.0\.0\.1:\$cdpPort\/json\/version/);
  assert.match(watchdog, /Test-CdpSession\.mjs/);
  assert.match(watchdog, /node\.exe \$cdpSessionProbe \$cdpPort 6000/);
  assert.match(watchdog, /if \(\$controllerAlive -and -not \(Test-CdpReady\)\)/);
  assert.match(watchdog, /-File \$startController -NoOpenDashboard/);
  assert.match(watchdog, /auto_restarted_browser_at/);
  assert.match(watchdog, /BROWSER_CDP_UNAVAILABLE/);
});

test('controller launcher replaces a half-alive dedicated Chrome session', () => {
  assert.match(startController, /function Test-CdpSession/);
  assert.match(startController, /function Stop-DedicatedChrome/);
  assert.match(startController, /browser session is unusable; restarting dedicated Chrome/);
  assert.match(startController, /Dedicated Chrome did not produce a usable CDP session/);
  assert.match(cdpProbe, /chromium\.connectOverCDP\(endpoint, \{ timeout: timeoutMs \}\)/);
  assert.match(cdpProbe, /CDP_SESSION_OK/);
});
