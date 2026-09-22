import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CONTROL_PATH = path.join(DATA_DIR, 'control.json');
const WATCHDOG_STATUS_PATH = path.join(DATA_DIR, 'watchdog-state.json');
const COORDINATOR_STATUS_PATH = path.join(DATA_DIR, 'coordinator-status.json');
const TRACKER_SNAPSHOT_PATH = path.join(DATA_DIR, 'tracker-snapshot.json');
const INCIDENT_DIR = path.join(DATA_DIR, 'incidents');
const DASHBOARD_PID_PATH = path.join(DATA_DIR, 'dashboard.pid');
const DASHBOARD_HTML_PATH = path.join(ROOT, 'dashboard.html');
const AUTOMATION_BOOTSTRAP_PATH = '/__r433_bootstrap';
const AUTOMATION_BOOTSTRAP_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>R433 automation bootstrap</title></head><body>R433 automation bootstrap</body></html>';
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
const port = Number(config.dashboardPort || 9350);
const controllerServiceName = String(config.controllerServiceName || 'r433-audit-controller.service');
const dashboardStartedAt = new Date().toISOString();

function now() {
  return new Date().toISOString();
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeResponse(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function recentIncidents() {
  let files = [];
  try {
    files = fs.readdirSync(INCIDENT_DIR).filter(file => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map(file => readJson(path.join(INCIDENT_DIR, file), null))
    .filter(Boolean)
    .sort((a, b) => String(b.detectedAt || '').localeCompare(String(a.detectedAt || '')))
    .slice(0, 30)
    .map(incident => ({
      id: incident.id || null,
      detectedAt: incident.detectedAt || null,
      kind: incident.kind || 'UNKNOWN',
      bucket: incident.bucket ?? null,
      detail: incident.detail || '',
      requiredAction: incident.requiredAction || null,
    }));
}

function snapshot() {
  const rawStatus = readJson(STATUS_PATH, {
    updatedAt: null,
    connected: false,
    runState: 'RECONCILIATION_ONLY',
    controllerState: 'RECONCILIATION_ONLY',
    dispatchEnabled: false,
    maxActiveReviewers: 2,
    activeReviewers: 0,
    buckets: {},
  });
  const state = readJson(STATE_PATH, {});
  const control = readJson(CONTROL_PATH, {
    desiredState: 'RECONCILIATION_ONLY',
    reason: 'CONTROL_FILE_ABSENT_OR_UNREADABLE',
  });
  const status = {
    ...rawStatus,
    maxActiveReviewers: Math.min(2, Math.max(1, Number(config.maxActiveReviewers || 2))),
    controllerState: rawStatus.controllerState || rawStatus.runState || control.desiredState || 'RECONCILIATION_ONLY',
    runState: rawStatus.runState || control.desiredState || 'RECONCILIATION_ONLY',
    dispatchEnabled: rawStatus.dispatchEnabled === true,
  };
  const coordinator = readJson(COORDINATOR_STATUS_PATH, null);
  const tracker = readJson(TRACKER_SNAPSHOT_PATH, null);
  const watchdog = readJson(WATCHDOG_STATUS_PATH, {
    state: 'UNKNOWN',
    updatedAt: null,
    issue: 'No watchdog status has been published yet.',
  });
  return {
    serverTime: now(),
    dashboard: { pid: process.pid, startedAt: dashboardStartedAt },
    status,
    control,
    watchdog,
    state: {
      startedAt: state.startedAt || null,
      runStartedAt: state.runStartedAt || null,
      runState: state.runState || null,
      workingMs: Number(state.workingMs || 0),
      metrics: state.metrics || {},
      completedAt: state.completedAt || null,
    },
    tracker,
    coordinator,
    incidents: recentIncidents(),
  };
}

async function runPowerShell(scriptName) {
  const script = path.join(ROOT, scriptName);
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 32_000, windowsHide: true });
}

async function runSystemctl(args) {
  return execFileAsync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 32000,
    windowsHide: true,
  });
}

async function controlController(action) {
  if (process.platform === 'win32') {
    if (action === 'stop') {
      await runPowerShell('Stop-Controller.ps1');
    } else {
      await runPowerShell('Stop-Controller.ps1');
      await runPowerShell('Start-Controller.ps1');
    }
    return;
  }
  if (process.platform !== 'linux') {
    throw new Error(`Controller controls are not configured for ${process.platform}.`);
  }

  if (action === 'stop') {
    await runSystemctl(['stop', controllerServiceName]);
    return;
  }

  const { stdout = '' } = await runSystemctl([
    'show', controllerServiceName, '--property=ActiveState', '--value',
  ]);
  const activeState = stdout.trim();
  if (activeState === 'active' || activeState === 'activating' || activeState === 'deactivating') {
    await runSystemctl(['restart', controllerServiceName]);
  } else {
    await runSystemctl(['reset-failed', controllerServiceName]);
    await runSystemctl(['start', controllerServiceName]);
  }
}

function setControl(desiredState, requestedBy = 'dashboard') {
  const existing = readJson(CONTROL_PATH, {});
  writeJsonAtomic(CONTROL_PATH, {
    ...existing,
    desiredState,
    requestedAt: now(),
    requestedBy,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 16000) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);

  if (req.method === 'GET' && url.pathname === AUTOMATION_BOOTSTRAP_PATH) {
    writeResponse(res, 200, 'text/html; charset=utf-8', AUTOMATION_BOOTSTRAP_HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
      writeResponse(res, 200, 'text/html; charset=utf-8', html);
    } catch (error) {
      writeResponse(res, 500, 'text/plain; charset=utf-8', `Dashboard unavailable: ${error.message}`);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    writeResponse(res, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot()));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/control') {
    try {
      const payload = JSON.parse(await readBody(req) || '{}');
      const action = String(payload.action || '').toLowerCase();
      const states = { stop: 'STOPPED', start: 'RUNNING' };
      if (!states[action]) {
        writeResponse(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: 'action must be stop or start' }));
        return;
      }
      setControl(states[action]);
      await controlController(action);
      writeResponse(res, 202, 'application/json; charset=utf-8', JSON.stringify({ accepted: true, action, desiredState: states[action] }));
    } catch (error) {
      writeResponse(res, 503, 'application/json; charset=utf-8', JSON.stringify({
        error: error.code === 'ETIMEDOUT' ? 'controller control command timed out' : error.message,
      }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    writeResponse(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, time: now(), pid: process.pid }));
    return;
  }

  writeResponse(res, 404, 'text/plain; charset=utf-8', 'Not found');
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(DASHBOARD_PID_PATH, String(process.pid), { encoding: 'ascii', mode: 0o600 });
const server = http.createServer((req, res) => {
  handle(req, res).catch(error => writeResponse(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: error.message })));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`R4.3.3 dashboard listening on http://127.0.0.1:${port}/`);
});
