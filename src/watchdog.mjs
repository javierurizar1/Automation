import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const CONTROL_PATH = path.join(DATA_DIR, 'control.json');
const WATCHDOG_PATH = path.join(DATA_DIR, 'watchdog-state.json');
const INCIDENT_DIR = path.join(DATA_DIR, 'incidents');
const execFileAsync = promisify(execFile);

const CONTROLLER_UNIT = process.env.R433_CONTROLLER_UNIT || 'r433-audit-controller.service';
const HEARTBEAT_STALE_MS = 120_000;
const STARTUP_GRACE_MS = 120_000;
const BROWSER_GRACE_MS = 90_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 30 * 60_000;
const INITIAL_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const RECOVERY_ONLY_STATES = new Set(['RECOVERING', 'RECONCILIATION_ONLY']);

function iso(time = Date.now()) {
  return new Date(time).toISOString();
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function parseProperties(text = '') {
  return Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map(line => {
    const index = line.indexOf('=');
    return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function systemctl(args) {
  return execFileAsync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 32_000,
    windowsHide: true,
  });
}

async function readUnitStatus() {
  const { stdout } = await systemctl([
    'show', CONTROLLER_UNIT,
    '--property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStatus',
  ]);
  return parseProperties(stdout);
}

function controllerProcessMatches(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    return cmdline.includes('src/controller.mjs') || cmdline.includes('/controller.mjs');
  } catch {
    return false;
  }
}

function timeMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function recentAttempts(attempts, now) {
  return Array.isArray(attempts)
    ? attempts.filter(item => timeMs(item?.at) != null && now - timeMs(item.at) < ATTEMPT_WINDOW_MS)
    : [];
}

function addIncident(issue, at, prior) {
  const previousTime = timeMs(prior.lastIncidentAt);
  if (prior.issue === issue && previousTime != null && at - previousTime < ATTEMPT_WINDOW_MS) {
    return { id: prior.lastIncidentId || null, at: prior.lastIncidentAt };
  }
  const id = `INC-WATCHDOG-${new Date(at).toISOString().replaceAll(/[-:.]/g, '')}`;
  const file = path.join(INCIDENT_DIR, `${id}.json`);
  writeJsonAtomic(file, {
    id,
    detectedAt: iso(at),
    kind: 'WATCHDOG_FAILURE',
    bucket: null,
    detail: issue,
    requiredAction: 'Review controller, browser, and watchdog status in the local dashboard.',
  });
  return { id, at: iso(at) };
}

function saveState(state) {
  state.updatedAt = iso();
  writeJsonAtomic(WATCHDOG_PATH, state);
}

function statusBase(prior, unit, control, now) {
  return {
    schemaVersion: 1,
    ...prior,
    updatedAt: iso(now),
    controllerUnit: CONTROLLER_UNIT,
    controllerService: {
      loadState: unit.LoadState || 'unknown',
      activeState: unit.ActiveState || 'unknown',
      subState: unit.SubState || 'unknown',
      mainPid: Number(unit.MainPID || 0),
      nRestarts: Number(unit.NRestarts || 0),
      lastExitStatus: Number(unit.ExecMainStatus || 0),
    },
    desiredState: String(control.desiredState || 'RECONCILIATION_ONLY').toUpperCase(),
    maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    recoveryWindowMs: ATTEMPT_WINDOW_MS,
  };
}

async function executeRecovery(unit, issue, state, now) {
  const attempts = recentAttempts(state.restartAttempts, now);
  const latestAttempt = attempts.length ? timeMs(attempts.at(-1).at) : null;
  const backoff = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempts.length - 1));
  const nextAllowed = latestAttempt == null ? null : latestAttempt + backoff;
  if (state.issue !== issue || !state.issueSince) state.issueSince = iso(now);
  state.issue = issue;
  state.restartAttempts = attempts;
  state.attemptsInWindow = attempts.length;

  if (attempts.length >= MAX_RECOVERY_ATTEMPTS) {
    state.state = 'DEGRADED';
    state.nextAttemptAt = iso((timeMs(attempts[0].at) || now) + ATTEMPT_WINDOW_MS);
    state.lastActionResult = 'RECOVERY_LIMIT_REACHED';
    saveState(state);
    return;
  }
  if (nextAllowed != null && now < nextAllowed) {
    state.state = 'RESTART_BACKOFF';
    state.nextAttemptAt = iso(nextAllowed);
    saveState(state);
    return;
  }

  const attempt = { at: iso(now), issue, result: 'IN_PROGRESS' };
  attempts.push(attempt);
  state.restartAttempts = attempts;
  state.attemptsInWindow = attempts.length;
  state.state = 'RESTARTING';
  state.lastActionAt = attempt.at;
  state.lastActionResult = 'IN_PROGRESS';
  state.nextAttemptAt = iso(now + INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempts.length - 1));
  saveState(state);

  try {
    if (unit.ActiveState === 'active') {
      await systemctl(['restart', CONTROLLER_UNIT]);
    } else {
      await systemctl(['reset-failed', CONTROLLER_UNIT]);
      await systemctl(['start', CONTROLLER_UNIT]);
    }
    attempt.result = 'ACCEPTED';
    state.lastActionResult = 'ACCEPTED';
    state.state = 'RECOVERING';
  } catch (error) {
    attempt.result = 'FAILED';
    state.lastActionResult = error.code === 'ETIMEDOUT' ? 'SYSTEMD_COMMAND_TIMEOUT' : 'SYSTEMD_COMMAND_FAILED';
    state.state = 'DEGRADED';
  }
  state.restartAttempts = attempts;
  state.lastActionAt = attempt.at;
  saveState(state);
}

export async function runWatchdog({ now = Date.now() } = {}) {
  if (process.platform !== 'linux') throw new Error('Linux watchdog can run only on Linux.');
  const prior = readJson(WATCHDOG_PATH, {});
  const control = readJson(CONTROL_PATH, { desiredState: 'RECONCILIATION_ONLY' }) || { desiredState: 'RECONCILIATION_ONLY' };
  let unit;
  try {
    unit = await readUnitStatus();
  } catch (error) {
    const state = {
      ...prior,
      schemaVersion: 1,
      state: 'ERROR',
      issue: 'SYSTEMD_STATUS_UNAVAILABLE',
      issueSince: prior.issue === 'SYSTEMD_STATUS_UNAVAILABLE' ? prior.issueSince : iso(now),
      detail: error.code === 'ETIMEDOUT' ? 'systemctl timed out' : 'systemctl --user could not read the controller unit',
      desiredState: String(control.desiredState || 'RECONCILIATION_ONLY').toUpperCase(),
      updatedAt: iso(now),
      controllerUnit: CONTROLLER_UNIT,
    };
    saveState(state);
    return state;
  }

  const state = statusBase(prior, unit, control, now);
  state.restartAttempts = recentAttempts(prior.restartAttempts, now);
  state.attemptsInWindow = state.restartAttempts.length;
  const recoveryOnly = RECOVERY_ONLY_STATES.has(state.desiredState);
  if (state.desiredState !== 'RUNNING' && !recoveryOnly) {
    state.state = 'SUPPRESSED';
    state.issue = null;
    state.issueSince = null;
    state.nextAttemptAt = null;
    state.suppressedState = state.desiredState;
    state.browserDisconnectedSince = null;
    saveState(state);
    return state;
  }
  state.suppressedState = null;

  const status = readJson(STATUS_PATH, null);
  const servicePid = Number(unit.MainPID || 0);
  const reportedPid = Number(status?.controllerPid || 0);
  const controllerPid = servicePid || reportedPid;
  const processAlive = controllerProcessMatches(controllerPid);
  const heartbeat = timeMs(status?.heartbeatAt ?? status?.updatedAt);
  const heartbeatAgeMs = heartbeat == null ? null : Math.max(0, now - heartbeat);
  state.controllerPid = controllerPid || null;
  state.reportedControllerPid = reportedPid || null;
  state.controllerPidMatches = !reportedPid || !servicePid || reportedPid === servicePid;
  state.heartbeatAt = status?.heartbeatAt || status?.updatedAt || null;
  state.heartbeatAgeMs = heartbeatAgeMs;
  state.controllerState = status?.controllerState || status?.runState || null;
  state.browserConnected = typeof status?.browserConnected === 'boolean'
    ? status.browserConnected
    : (typeof status?.connected === 'boolean' ? status.connected : null);

  if (unit.LoadState !== 'loaded') {
    state.state = 'ERROR';
    state.issue = 'CONTROLLER_UNIT_NOT_INSTALLED';
    state.issueSince = prior.issue === state.issue ? prior.issueSince : iso(now);
    state.lastActionResult = 'NO_ACTION_UNIT_MISSING';
    state.nextAttemptAt = null;
    saveState(state);
    return state;
  }

  if (unit.ActiveState === 'activating' || unit.ActiveState === 'deactivating') {
    const transitionAt = timeMs(prior.transitionObservedAt) || now;
    state.transitionObservedAt = iso(transitionAt);
    if (now - transitionAt < STARTUP_GRACE_MS) {
      state.state = 'RECOVERING';
      state.issueSince = prior.issue === 'CONTROLLER_SERVICE_TRANSITION' ? (prior.issueSince || iso(now)) : iso(now);
      state.issue = 'CONTROLLER_SERVICE_TRANSITION';
      state.nextAttemptAt = iso(now + 30_000);
      saveState(state);
      return state;
    }
    await executeRecovery(unit, 'CONTROLLER_SERVICE_TRANSITION_TIMEOUT', state, now);
    return state;
  }
  state.transitionObservedAt = null;

  let issue = null;
  if (unit.ActiveState !== 'active') {
    issue = Number(unit.NRestarts || 0) >= MAX_RECOVERY_ATTEMPTS
      ? 'REPEATED_CONTROLLER_CRASHES'
      : 'CONTROLLER_SERVICE_NOT_ACTIVE';
  } else if (!processAlive) {
    issue = 'CONTROLLER_PROCESS_NOT_LIVE';
  } else if (heartbeat == null || heartbeatAgeMs > HEARTBEAT_STALE_MS) {
    const stateAge = timeMs(status?.startedAt);
    const missingSince = heartbeat == null ? (timeMs(prior.statusMissingSince) || now) : null;
    state.statusMissingSince = heartbeat == null ? iso(missingSince) : null;
    const graceStart = stateAge ?? missingSince;
    const stillStarting = (RECOVERY_ONLY_STATES.has(state.controllerState) || heartbeat == null)
      && graceStart != null && now - graceStart < STARTUP_GRACE_MS;
    if (stillStarting) {
      state.state = 'RECOVERING';
      state.issueSince = prior.issue === 'CONTROLLER_STARTUP_GRACE' ? (prior.issueSince || iso(now)) : iso(now);
      state.issue = 'CONTROLLER_STARTUP_GRACE';
      state.nextAttemptAt = iso(graceStart + STARTUP_GRACE_MS);
      saveState(state);
      return state;
    }
    issue = 'CONTROLLER_HEARTBEAT_STALE';
  } else if (state.controllerState === 'STOPPED' || state.controllerState === 'ERROR') {
    issue = state.controllerState === 'STOPPED' ? 'CONTROLLER_STOPPED_UNEXPECTEDLY' : 'CONTROLLER_REPORTED_ERROR';
  }

if (!issue && state.browserConnected === false) {
    const disconnectedAt = timeMs(prior.browserDisconnectedSince) || now;
    state.browserDisconnectedSince = iso(disconnectedAt);
    const recoveryStartedAt = RECOVERY_ONLY_STATES.has(state.controllerState)
      ? (timeMs(prior.browserRecoverySince) || now)
      : null;
    state.browserRecoverySince = recoveryStartedAt == null ? null : iso(recoveryStartedAt);
    const recoveryGraceActive = recoveryStartedAt != null && now - recoveryStartedAt < STARTUP_GRACE_MS;
    if (now - disconnectedAt < BROWSER_GRACE_MS || recoveryGraceActive) {
      state.state = 'DEGRADED';
      state.issueSince = prior.issue === 'BROWSER_DISCONNECTED_GRACE' ? (prior.issueSince || iso(now)) : iso(now);
      state.issue = 'BROWSER_DISCONNECTED_GRACE';
      state.nextAttemptAt = iso(disconnectedAt + BROWSER_GRACE_MS);
      state.lastHealthyAt = prior.lastHealthyAt || null;
      const incident = addIncident(state.issue, now, prior);
      state.lastIncidentId = incident.id;
      state.lastIncidentAt = incident.at;
      saveState(state);
      return state;
    }
    issue = 'BROWSER_DISCONNECTED';
  } else if (!issue && state.browserConnected == null) {
    state.state = 'DEGRADED';
    state.issueSince = prior.issue === 'BROWSER_HEALTH_UNKNOWN' ? (prior.issueSince || iso(now)) : iso(now);
    state.issue = 'BROWSER_HEALTH_UNKNOWN';
    state.nextAttemptAt = iso(now + 30_000);
    const incident = addIncident(state.issue, now, prior);
    state.lastIncidentId = incident.id;
    state.lastIncidentAt = incident.at;
    saveState(state);
    return state;
  } else if (!issue) {
    state.browserDisconnectedSince = null;
    state.browserRecoverySince = null;
  }

  if (issue) {
    const incident = addIncident(issue, now, prior);
    state.lastIncidentId = incident.id;
    state.lastIncidentAt = incident.at;
    await executeRecovery(unit, issue, state, now);
    return state;
  }

  state.state = recoveryOnly
    ? 'HEALTHY_RECOVERY'
    : (Number(unit.NRestarts || 0) >= MAX_RECOVERY_ATTEMPTS ? 'HEALTHY_AFTER_RESTARTS' : 'HEALTHY');
  state.issue = null;
  state.issueSince = null;
  state.detail = recoveryOnly ? 'Controller is healthy; dispatch remains disabled during reconciliation-only recovery.' : null;
  state.nextAttemptAt = null;
  state.lastHealthyAt = iso(now);
  state.lastActionResult ||= null;
  state.lastIncidentId = prior.lastIncidentId || null;
  saveState(state);
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWatchdog().catch(error => {
    const state = {
      schemaVersion: 1,
      state: 'ERROR',
      issue: 'WATCHDOG_EXECUTION_FAILED',
      detail: error.code === 'ETIMEDOUT' ? 'Watchdog operation timed out.' : 'Watchdog execution failed.',
      updatedAt: iso(),
      controllerUnit: CONTROLLER_UNIT,
    };
    try { saveState(state); } catch {}
    process.exitCode = 1;
  });
}
