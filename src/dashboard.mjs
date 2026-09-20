import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1')), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CONTROL_PATH = path.join(DATA_DIR, 'control.json');
const COORDINATOR_STATUS_PATH = path.join(DATA_DIR, 'coordinator-status.json');
const TRACKER_SNAPSHOT_PATH = path.join(DATA_DIR, 'tracker-snapshot.json');
const INCIDENT_DIR = path.join(DATA_DIR, 'incidents');
const DASHBOARD_PID_PATH = path.join(DATA_DIR, 'dashboard.pid');
const DASHBOARD_HTML_PATH = path.join(ROOT, 'dashboard.html');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
const port = Number(config.dashboardPort || 9350);

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
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
    runState: 'UNKNOWN',
    maxActiveReviewers: 2,
    activeReviewers: 0,
    buckets: {},
  });
  const state = readJson(STATE_PATH, {});
  const control = readJson(CONTROL_PATH, { desiredState: 'RUNNING' });
  const status = {
    ...rawStatus,
    maxActiveReviewers: Math.min(2, Math.max(1, Number(config.maxActiveReviewers || 2))),
    runState: rawStatus.runState || control.desiredState || 'UNKNOWN',
  };
  const coordinator = readJson(COORDINATOR_STATUS_PATH, null);
  const tracker = readJson(TRACKER_SNAPSHOT_PATH, null);
  return {
    serverTime: now(),
    status,
    control,
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

function spawnPowerShell(scriptName) {
  const script = path.join(ROOT, scriptName);
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
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
      if (action === 'stop') spawnPowerShell('Stop-Controller.ps1');
      if (action === 'start') spawnPowerShell('Start-Controller.ps1');
      writeResponse(res, 202, 'application/json; charset=utf-8', JSON.stringify({ accepted: true, action, desiredState: states[action] }));
    } catch (error) {
      writeResponse(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    writeResponse(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, time: now() }));
    return;
  }

  writeResponse(res, 404, 'text/plain; charset=utf-8', 'Not found');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(DASHBOARD_PID_PATH, String(process.pid), 'ascii');
const server = http.createServer((req, res) => {
  handle(req, res).catch(error => writeResponse(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: error.message })));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`R4.3.3 dashboard listening on http://127.0.0.1:${port}/`);
});
