import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const incidentPath = process.argv[2];
const sessionPath = path.join(dataDir, 'codex-coordinator.json');
const resultPath = path.join(dataDir, 'codex-coordinator-last.txt');
const eventsPath = path.join(dataDir, 'codex-coordinator-last.jsonl');
const metaPath = path.join(dataDir, 'codex-coordinator-last-meta.json');
const statusPath = path.join(dataDir, 'coordinator-status.json');
const wakeLogPath = path.join(root, 'logs', 'coordinator-wake.log');
const now = () => new Date().toISOString();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJson(file, value) {
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function updateStatus(patch) {
  writeJson(statusPath, { ...readJson(statusPath), ...patch });
}

function writeWakeLog(message) {
  try { fs.appendFileSync(wakeLogPath, now() + ' ' + message + '\n'); } catch {}
}

function threadIdFromJsonLines(output) {
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      const id = event.thread_id || event.session_id || event.conversation_id;
      if (id) return String(id);
    } catch {}
  }
  return null;
}

function runCodex(args, prompt) {
  fs.rmSync(resultPath, { force: true });
  const result = spawnSync('codex', ['--approve-for-me', '-C', root, 'exec', ...args], {
    cwd: root,
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || null,
  };
}

let incidentId = null;
let queuedAt = null;
let startedAt = null;
try {
  writeWakeLog('started for incident path ' + incidentPath);
  if (!incidentPath || !fs.existsSync(incidentPath)) {
    throw new Error('Incident file does not exist: ' + incidentPath);
  }
  const incident = fs.readFileSync(incidentPath, 'utf8');
  incidentId = String(JSON.parse(incident).id || '');
  if (!incidentId) throw new Error('Incident file has no id: ' + incidentPath);
  queuedAt = now();
  updateStatus({
    status: 'QUEUED', incidentId, queuedAt, startedAt: null,
    completedAt: null, exitCode: null, resultPath, error: null,
    workerPid: process.pid,
  });
  writeWakeLog('lock acquired for ' + incidentId);

  let sessionId = readJson(sessionPath).session_id || null;
  const prompt = [
    'You are the persistent R4.3.3 Audit Controller Coordinator for the local Linux controller at:',
    '', root, '',
    'An automated incident has just been raised. Read these local artifacts before acting:',
    '- incident: ' + incidentPath,
    '- state: ' + path.join(dataDir, 'state.json'),
    '- status: ' + path.join(dataDir, 'status.json'),
    '- controller log: ' + path.join(root, 'logs', 'controller.log'),
    '- config: ' + path.join(root, 'config.json'),
    '- controller source: ' + path.join(root, 'src', 'controller.mjs'),
    '', 'Incident payload:', incident, '',
    'Your job is to diagnose the exact failure and restore continuous review when that can be done safely.',
    'Use this Codex CLI session for coordination; do not open a browser coordinator chat.',
    '', 'Hard invariants:',
    '1. Preserve all authoritative audit registry results and every already terminalized case.',
    '2. Never reset, reconstruct, or replace state.json.',
    '3. Never clear arbitrary ChatGPT composer text.',
    '4. Never destroy or replace the dedicated Chrome profile.',
    '5. Never mint duplicate reviewer actions or duplicate bucket chats.',
    '6. Prove draft/action ownership before submitting an existing draft.',
    '7. If a bucket is COMPLETE, do not send more review work to it.',
    '8. Keep at most two active reviewer chats and start or resume pending Buckets 0-5 only as those two slots become available.',
    '9. Prefer a narrow reversible controller/code repair. Restart only the controller/watchdog if required; do not restart Chrome unless the browser itself is the verified failure.',
    '10. If safe autonomous recovery is impossible, leave state intact and identify the exact user action needed.',
    '', 'When you finish, begin the final response with exactly one of:',
    'RECOVERED:', 'NEEDS_USER:', 'MONITORING:',
    '', 'Then give a concise factual result. If you changed code, run the narrowest useful syntax/tests and verify the controller status advances after the repair.',
    '',
  ].join('\n');

  startedAt = now();
  updateStatus({
    status: 'RUNNING', incidentId, queuedAt, startedAt,
    completedAt: null, exitCode: null, resultPath, error: null,
    workerPid: process.pid,
  });
  let result;
  if (sessionId) {
    writeWakeLog('resuming coordinator session ' + sessionId);
    result = runCodex(['resume', '--skip-git-repo-check', '-o', resultPath, sessionId, '-'], prompt);
  }
  if (!sessionId || result.exitCode !== 0) {
    writeWakeLog('starting a new coordinator session');
    result = runCodex(['--json', '--skip-git-repo-check', '-o', resultPath, '-'], prompt);
    const newSessionId = threadIdFromJsonLines(result.stdout);
    if (newSessionId) {
      sessionId = newSessionId;
      writeJson(sessionPath, {
        session_id: sessionId, created_at: now(),
        purpose: 'R4.3.3 audit controller incident coordinator',
      });
    }
  }

  fs.writeFileSync(eventsPath, result.stdout + result.stderr, { mode: 0o600 });
  if (!fs.existsSync(resultPath)) {
    fs.writeFileSync(resultPath, 'Coordinator exited with code ' + result.exitCode + ' and produced no final result.\n', { mode: 0o600 });
  }
  const completedAt = now();
  writeJson(metaPath, {
    completed_at: completedAt, exit_code: result.exitCode,
    session_id: sessionId, incident_path: incidentPath, result_path: resultPath,
  });
  updateStatus({
    status: result.exitCode === 0 ? 'COMPLETED' : 'FAILED',
    incidentId, queuedAt, startedAt, completedAt,
    latencyMs: Date.parse(completedAt) - Date.parse(startedAt),
    exitCode: result.exitCode, resultPath, workerPid: null,
    error: result.exitCode === 0 ? null : (result.error || 'Codex exited with code ' + result.exitCode),
  });
  writeWakeLog('completed ' + incidentId + (result.exitCode === 0 ? ' successfully' : ' with exit code ' + result.exitCode));
  process.exitCode = result.exitCode;
} catch (error) {
  writeWakeLog('failed for ' + incidentId + ': ' + error.message);
  try {
    updateStatus({
      status: 'FAILED', incidentId, queuedAt, startedAt,
      completedAt: now(), exitCode: null, resultPath,
      workerPid: null, error: error.message,
    });
  } catch {}
  process.exitCode = 1;
}
