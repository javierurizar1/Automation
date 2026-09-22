import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  bootstrapAutomationProfile,
  cleanupAutomationProfileEphemeral,
  connectOrLaunchBrowser,
  discoverChromiumCandidates,
  AUTOMATION_BOOTSTRAP_URL,
  normalizeBrowserProfileMode,
  terminateOwnedBrowserProcessGroup,
  validateSourceBrowserProfile,
} from '../src/browser-runtime.mjs';
import {
  classifyReviewerHealth,
  ensureBrowserPageBudget,
  findActualGeneration,
} from '../src/reviewer-tabs.mjs';

function makeFakeBrowserExecutable(directory, name) {
  const executable = path.join(directory, name);
  fs.writeFileSync(executable, `#!/usr/bin/python3
import os, signal, sys, time
marker = os.environ['CODEX_TEST_BROWSER_MARKER']
with open(marker, 'a', encoding='utf-8') as handle:
    handle.write(os.path.basename(sys.argv[0]) + '\\n')
args_marker = os.environ.get('CODEX_TEST_BROWSER_ARGS_MARKER')
if args_marker:
    with open(args_marker, 'a', encoding='utf-8') as handle:
        handle.write(' '.join(sys.argv[1:]) + '\\n')
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    try:
        with open(marker, encoding='utf-8') as handle:
            if handle.read().splitlines()[-1:] == ['CONNECTED']:
                break
    except FileNotFoundError:
        pass
    time.sleep(0.01)
`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

async function stopProcess(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(10);
  }
  throw new Error(`test browser process ${pid} did not exit`);
}

function makeReviewerPage({
  url = 'https://chatgpt.com/c/test',
  closed = false,
  connected = true,
  dom = { bodyText: '', stopSelector: null, composer: true, readyState: 'complete', online: true },
  evaluate = null,
} = {}) {
  return {
    isClosed: () => closed,
    context: () => ({ browser: () => ({ isConnected: () => connected }) }),
    url: () => url,
    evaluate: evaluate || (async () => dom),
  };
}

test('browser candidates prefer the configured browser and retain supported fallbacks', () => {
  const candidates = discoverChromiumCandidates({
    preferredExecutable: 'brave-browser',
    candidateExecutables: ['chromium', 'firefox', 'microsoft-edge'],
    platform: 'linux',
    env: { PATH: '' },
  });
  assert.deepEqual(candidates, ['brave-browser', 'chromium', 'microsoft-edge']);
  assert.deepEqual(discoverChromiumCandidates({
    preferredExecutable: 'Brave Browser',
    platform: 'linux',
    env: { PATH: '' },
  }), ['Brave Browser']);
});

test('failed preferred Brave startup falls back within bounded startup to Chromium', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-fallback-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const markerPath = path.join(directory, 'launches.txt');
  const argsMarkerPath = path.join(directory, 'browser-args.txt');
  const brave = makeFakeBrowserExecutable(directory, 'brave-browser');
  const chromium = makeFakeBrowserExecutable(directory, 'chromium');
  const context = { pages: () => [] };
  const browser = { contexts: () => [context] };

  let connected;
  try {
    connected = await connectOrLaunchBrowser({
      endpoint: 'http://127.0.0.1:59222',
      preferredExecutable: brave,
      candidateExecutables: [brave, chromium],
      profileDir: path.join(directory, 'preserved-profile'),
      profileMode: 'clone',
      profileDirectoryName: 'Default',
      connectTimeoutMs: 40,
      startupTimeoutMs: 100,
      retryIntervalMs: 5,
      env: {
        ...process.env,
        CODEX_TEST_BROWSER_MARKER: markerPath,
        CODEX_TEST_BROWSER_ARGS_MARKER: argsMarkerPath,
      },
      playwrightChromium: {
        async connectOverCDP() {
          const launches = fs.existsSync(markerPath)
            ? fs.readFileSync(markerPath, 'utf8').trim().split(/\r?\n/)
            : [];
          if (launches.at(-1) === 'chromium') {
            fs.appendFileSync(markerPath, 'CONNECTED\n');
            return browser;
          }
          throw new Error('CDP unavailable for preferred browser');
        },
      },
    });

    assert.equal(connected.launched, true);
    assert.equal(connected.executable, chromium);
    assert.equal(connected.profileDir, path.join(directory, 'preserved-profile'));
    assert.equal(connected.profileDirectoryName, 'Default');
    const browserArgs = fs.readFileSync(argsMarkerPath, 'utf8');
    assert.match(browserArgs, /--user-data-dir=/);
    assert.match(browserArgs, /--profile-directory=Default/);
    assert.match(browserArgs, new RegExp(AUTOMATION_BOOTSTRAP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(browserArgs, /about:blank/);
    assert.deepEqual(fs.readFileSync(markerPath, 'utf8').trim().split(/\r?\n/), [
      'brave-browser',
      'chromium',
      'CONNECTED',
    ]);
  } finally {
    await stopProcess(connected?.pid);
  }
});

test('browser startup returns BROWSER_UNAVAILABLE after the configured finite deadline', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-timeout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const markerPath = path.join(directory, 'launches.txt');
  const browserCandidate = makeFakeBrowserExecutable(directory, 'brave-browser');
  const startedAt = Date.now();

  await assert.rejects(connectOrLaunchBrowser({
    endpoint: 'http://127.0.0.1:59223',
    preferredExecutable: browserCandidate,
    candidateExecutables: [browserCandidate],
    profileDir: path.join(directory, 'profile'),
    profileMode: 'clone',
    connectTimeoutMs: 30,
    startupTimeoutMs: 80,
    retryIntervalMs: 5,
    env: { ...process.env, CODEX_TEST_BROWSER_MARKER: markerPath },
    playwrightChromium: { async connectOverCDP() { throw new Error('CDP unavailable'); } },
  }), error => {
    assert.equal(error.code, 'BROWSER_UNAVAILABLE');
    assert.ok(error.attempts.some(attempt => attempt.phase === 'browser-startup'));
    return true;
  });
  assert.ok(Date.now() - startedAt < 1500, 'startup failure must remain bounded');
});

test('default Brave profile is cloned once into ignored automation data and then reused', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const source = path.join(home, '.config', 'BraveSoftware', 'Brave-Browser');
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(path.join(source, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Local State'), '{"profile":{}}');
  fs.writeFileSync(path.join(source, 'Default', 'Preferences'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Cookies'), 'auth');
  fs.writeFileSync(path.join(source, 'Default', 'LOCK'), '');
  const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(source, 'Default', 'LOCK'), staleTime, staleTime);
  fs.mkdirSync(path.join(source, 'Default', 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Default', 'Cache', 'discarded'), 'cache');
  const first = await bootstrapAutomationProfile({
    profileDir: source,
    projectRoot,
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    procRoot: '/proc',
  });
  assert.equal(first.bootstrapped, true);
  assert.equal(fs.readFileSync(path.join(first.profileDir, 'Default', 'Cookies'), 'utf8'), 'auth');
  assert.equal(fs.existsSync(path.join(first.profileDir, 'Default', 'Cache', 'discarded')), false);
  const second = await bootstrapAutomationProfile({
    profileDir: source,
    projectRoot,
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    procRoot: '/proc',
  });
  assert.equal(second.reused, true);
  assert.equal(second.profileDir, first.profileDir);
});

test('source profile mode launches the configured persistent profile without cloning', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source-profile');
  const projectRoot = path.join(directory, 'project');
  const markerPath = path.join(directory, 'launches.txt');
  const argsMarkerPath = path.join(directory, 'browser-args.txt');
  const browserCandidate = makeFakeBrowserExecutable(directory, 'brave-browser');
  fs.mkdirSync(path.join(source, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Local State'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Preferences'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Cookies'), 'authenticated-session');
  const context = { pages: () => [] };
  const browser = { contexts: () => [context] };
  let connected;
  try {
    connected = await connectOrLaunchBrowser({
      endpoint: 'http://127.0.0.1:59226',
      preferredExecutable: browserCandidate,
      candidateExecutables: [browserCandidate],
      profileDir: source,
      profileMode: 'source',
      profileDirectoryName: 'Default',
      projectRoot,
      connectTimeoutMs: 40,
      startupTimeoutMs: 300,
      retryIntervalMs: 5,
      env: {
        ...process.env,
        CODEX_TEST_BROWSER_MARKER: markerPath,
        CODEX_TEST_BROWSER_ARGS_MARKER: argsMarkerPath,
      },
      playwrightChromium: {
        async connectOverCDP() {
          if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8').includes('brave-browser')) {
            if (!fs.readFileSync(markerPath, 'utf8').includes('CONNECTED')) fs.appendFileSync(markerPath, 'CONNECTED\n');
            return browser;
          }
          throw new Error('CDP unavailable');
        },
      },
    });
    assert.equal(connected.profileMode, 'source');
    assert.equal(connected.profileDir, path.resolve(source));
    assert.equal(connected.profileDirectoryName, 'Default');
    assert.equal(fs.existsSync(path.join(projectRoot, 'data', 'browser-profile')), false);
    assert.equal(fs.readFileSync(path.join(source, 'Default', 'Cookies'), 'utf8'), 'authenticated-session');
    assert.ok(fs.readFileSync(argsMarkerPath, 'utf8').includes(`--user-data-dir=${source}`));
  } finally {
    await stopProcess(connected?.pid);
  }
});

test('CDP attach failure falls back to a bounded visible persistent source context', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-persistent-fallback-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source-profile');
  const browserCandidate = makeFakeBrowserExecutable(directory, 'google-chrome');
  fs.mkdirSync(path.join(source, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Local State'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Preferences'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Cookies'), 'authenticated-session');

  let context;
  const browser = { contexts: () => [context] };
  context = {
    pages: () => [],
    browser: () => browser,
    close: async () => {},
  };
  let connectCalls = 0;
  const persistentLaunches = [];
  const connected = await connectOrLaunchBrowser({
    endpoint: 'http://127.0.0.1:59229',
    preferredExecutable: browserCandidate,
    candidateExecutables: [browserCandidate],
    profileDir: source,
    profileMode: 'source',
    profileDirectoryName: 'Default',
    connectTimeoutMs: 25,
    startupTimeoutMs: 150,
    retryIntervalMs: 5,
    playwrightChromium: {
      async connectOverCDP() {
        connectCalls += 1;
        throw new Error('CRPage initialization timeout');
      },
      async launchPersistentContext(userDataDir, options) {
        persistentLaunches.push({ userDataDir, options });
        return context;
      },
    },
  });

  assert.equal(connectCalls, 1, 'CDP attach remains the first attempt');
  assert.equal(persistentLaunches.length, 1);
  assert.equal(persistentLaunches[0].userDataDir, path.resolve(source));
  assert.equal(persistentLaunches[0].options.headless, false);
  assert.equal(persistentLaunches[0].options.executablePath, browserCandidate);
  assert.equal(persistentLaunches[0].options.viewport, null);
  assert.match(persistentLaunches[0].options.args.join(' '), new RegExp(AUTOMATION_BOOTSTRAP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(persistentLaunches[0].options.args.join(' '), /about:blank/);
  assert.equal(connected.browser, browser);
  assert.equal(connected.context, context);
  assert.equal(connected.transport, 'persistent');
  assert.equal(connected.launched, true);
  assert.equal(connected.profileMode, 'source');
  assert.equal(connected.profileDir, path.resolve(source));
});

test('source profile mode rejects an actively owned profile before launch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-source-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source-profile');
  const markerPath = path.join(directory, 'launches.txt');
  fs.mkdirSync(path.join(source, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Local State'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Preferences'), '{}');
  fs.writeFileSync(path.join(source, 'SingletonLock'), 'owned');
  const browserCandidate = makeFakeBrowserExecutable(directory, 'brave-browser');
  let persistentLaunchCalls = 0;
  await assert.rejects(connectOrLaunchBrowser({
    endpoint: 'http://127.0.0.1:59227',
    preferredExecutable: browserCandidate,
    candidateExecutables: [browserCandidate],
    profileDir: source,
    profileMode: 'source',
    env: { ...process.env, CODEX_TEST_BROWSER_MARKER: markerPath },
    playwrightChromium: {
      async connectOverCDP() { throw new Error('CDP unavailable'); },
      async launchPersistentContext() { persistentLaunchCalls += 1; },
    },
  }), error => error.code === 'BROWSER_PROFILE_IN_USE');
  assert.equal(persistentLaunchCalls, 0, 'an active external profile is never touched by fallback');
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(fs.existsSync(path.join(source, 'SingletonLock')), true);
});

test('source profile validation preserves profile cookies and locks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-source-validate-'));
  try {
    const source = path.join(directory, 'source-profile');
    fs.mkdirSync(path.join(source, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(source, 'Local State'), '{}');
    fs.writeFileSync(path.join(source, 'Default', 'Preferences'), '{}');
    fs.writeFileSync(path.join(source, 'Default', 'Cookies'), 'keep');
    fs.writeFileSync(path.join(source, 'SingletonLock'), 'stale-lock');
    const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(source, 'SingletonLock'), staleTime, staleTime);
    const validated = validateSourceBrowserProfile({
      profileDir: source,
      profileDirectoryName: 'Default',
      preferredExecutable: 'brave-browser',
      platform: 'linux',
      env: { HOME: directory, XDG_CONFIG_HOME: path.join(directory, '.config') },
      procRoot: '/proc',
    });
    assert.equal(validated.profileMode, 'source');
    assert.equal(fs.readFileSync(path.join(source, 'Default', 'Cookies'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(source, 'SingletonLock')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('browser profile mode defaults to source and rejects unknown values', () => {
  assert.equal(normalizeBrowserProfileMode(), 'source');
  assert.equal(normalizeBrowserProfileMode('clone'), 'clone');
  assert.throws(() => normalizeBrowserProfileMode('rotate'), error => error.code === 'BROWSER_PROFILE_MODE_INVALID');
});

test('sanitized config declares explicit persistent source profile settings', () => {
  const example = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'recovered-config.json'), 'utf8'));
  assert.equal(example.browserProfileMode, 'source');
  assert.equal(example.browserProfileName, 'Default');
  assert.ok(Object.hasOwn(example, 'browserProfileDir'));
});

test('recent source profile lock remains a fail-closed blocker', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-profile-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const source = path.join(home, '.config', 'BraveSoftware', 'Brave-Browser');
  fs.mkdirSync(path.join(source, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Local State'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Preferences'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'LOCK'), '');
  await assert.rejects(bootstrapAutomationProfile({
    profileDir: source,
    projectRoot: path.join(directory, 'project'),
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    procRoot: '/proc',
  }), error => error.code === 'BROWSER_PROFILE_IN_USE');
});

test('reuses an isolated profile after removing a stale destination lock', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-browser-destination-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const source = path.join(home, '.config', 'BraveSoftware', 'Brave-Browser');
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(path.join(source, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Local State'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Preferences'), '{}');
  fs.writeFileSync(path.join(source, 'Default', 'Cookies'), 'auth');
  const first = await bootstrapAutomationProfile({
    profileDir: source,
    projectRoot,
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    procRoot: '/proc',
  });
  const destinationLock = path.join(first.profileDir, 'Default', 'LOCK');
  const destinationSingleton = path.join(first.profileDir, 'SingletonLock');
  fs.writeFileSync(destinationLock, 'owned-browser-left-this');
  fs.writeFileSync(destinationSingleton, 'owned-browser-left-this');
  const second = await bootstrapAutomationProfile({
    profileDir: source,
    projectRoot,
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    procRoot: '/proc',
  });
  assert.equal(second.reused, true);
  assert.equal(fs.existsSync(destinationLock), false);
  assert.equal(fs.existsSync(destinationSingleton), false);
  cleanupAutomationProfileEphemeral({ profileDir: first.profileDir, profileDirectoryName: 'Default' });
});

test('owned browser cleanup terminates only the verified process group and removes destination locks', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-owned-browser-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profileDir = path.join(directory, 'profile');
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'SingletonLock'), 'owned');
  const sleeper = path.join(directory, 'sleeper.mjs');
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 30000);\n');
  const child = process.platform === 'linux'
    ? spawn(process.execPath, [
      sleeper,
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=59224',
    ], { detached: true, stdio: 'ignore' })
    : null;
  if (!child?.pid) return;
  child.unref();
  await delay(80);

  const result = await terminateOwnedBrowserProcessGroup({
    pid: child.pid,
    profileDir,
    profileDirectoryName: 'Default',
    remoteDebuggingPort: 59224,
    timeoutMs: 250,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.stopped, true);
  assert.equal(fs.existsSync(path.join(profileDir, 'SingletonLock')), false);
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
});

test('owned source browser cleanup stops only the process and preserves source locks/cookies', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-owned-source-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profileDir = path.join(directory, 'profile');
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'SingletonLock'), 'owned');
  fs.writeFileSync(path.join(profileDir, 'Default', 'Cookies'), 'keep');
  const sleeper = path.join(directory, 'sleeper.mjs');
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 30000);\n');
  const child = process.platform === 'linux'
    ? spawn(process.execPath, [sleeper, `--user-data-dir=${profileDir}`, '--remote-debugging-port=59228'], { detached: true, stdio: 'ignore' })
    : null;
  if (!child?.pid) return;
  child.unref();
  await delay(80);
  const result = await terminateOwnedBrowserProcessGroup({
    pid: child.pid,
    profileDir,
    profileDirectoryName: 'Default',
    remoteDebuggingPort: 59228,
    cleanupEphemeral: false,
    timeoutMs: 250,
  });
  assert.equal(result.stopped, true);
  assert.equal(fs.existsSync(path.join(profileDir, 'SingletonLock')), true);
  assert.equal(fs.readFileSync(path.join(profileDir, 'Default', 'Cookies'), 'utf8'), 'keep');
});

test('owned browser cleanup refuses a process whose profile ownership cannot be proven', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r433-owned-browser-ownership-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const actualProfile = path.join(directory, 'actual');
  const expectedProfile = path.join(directory, 'expected');
  fs.mkdirSync(actualProfile, { recursive: true });
  const sleeper = path.join(directory, 'sleeper.mjs');
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 30000);\n');
  const child = process.platform === 'linux'
    ? spawn(process.execPath, [sleeper, `--user-data-dir=${actualProfile}`, '--remote-debugging-port=59225'], {
      detached: true,
      stdio: 'ignore',
    })
    : null;
  if (!child?.pid) return;
  child.unref();
  await delay(80);
  try {
    const result = await terminateOwnedBrowserProcessGroup({
      pid: child.pid,
      profileDir: expectedProfile,
      remoteDebuggingPort: 59225,
      timeoutMs: 250,
    });
    assert.equal(result.attempted, false);
    assert.equal(result.reason, 'OWNERSHIP_UNVERIFIED');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

test('reviewer health requires live evidence and recognizes reconnecting, offline, and disconnected pages', async () => {
  const reconnecting = await classifyReviewerHealth(makeReviewerPage({
    dom: { bodyText: 'Reconnecting…', stopSelector: 'button[data-testid="stop-button"]', composer: true, online: true },
  }));
  assert.equal(reconnecting.state, 'RECONNECTING');
  assert.equal(reconnecting.actualGeneration, false);

  const offline = await classifyReviewerHealth(makeReviewerPage({
    dom: { bodyText: 'Waiting for network', stopSelector: null, composer: true, online: false },
  }));
  assert.equal(offline.state, 'WAITING_NETWORK');
  assert.equal(offline.actualGeneration, false);

  const disconnected = await classifyReviewerHealth(makeReviewerPage({ connected: false }));
  assert.equal(disconnected.state, 'DISCONNECTED');
  assert.equal(disconnected.actualGeneration, false);
});

test('ChatGPT landing-page login markers expose HUMAN_AUTH_REQUIRED', async () => {
  const health = await classifyReviewerHealth(makeReviewerPage({
    url: 'https://chatgpt.com/',
    dom: {
      bodyText: 'Log in to get answers based on saved chats, plus create images and upload files. Log in Sign up for free',
      stopSelector: null,
      composer: false,
      readyState: 'complete',
      online: true,
    },
  }));
  assert.equal(health.state, 'AUTH_REQUIRED');
  assert.equal(health.actualGeneration, false);
  assert.match(health.reason, /HUMAN_AUTH_REQUIRED/);
  assert.equal(health.evidence.authenticationRequired, true);
});

test('reviewer generation is counted only when the page exposes an active generation control', async () => {
  const healthy = makeReviewerPage({
    dom: { bodyText: 'Completed response', stopSelector: null, composer: true, readyState: 'complete', online: true },
  });
  assert.equal((await findActualGeneration(healthy)).active, false);

  const generating = makeReviewerPage({
    dom: { bodyText: 'Drafting response', stopSelector: 'button[data-testid="stop-button"]', composer: true, online: true },
  });
  assert.equal((await findActualGeneration(generating)).active, true);
});

test('reviewer health probe timeout is bounded and does not claim a generation', async () => {
  const startedAt = Date.now();
  const health = await classifyReviewerHealth(makeReviewerPage({ evaluate: () => new Promise(() => {}) }), { timeoutMs: 100 });
  assert.equal(health.state, 'UNREACHABLE');
  assert.equal(health.actualGeneration, false);
  assert.ok(Date.now() - startedAt < 1000);
});

test('browser page budget permits one coordinator plus two reusable reviewer slots', async () => {
  const coordinator = makeReviewerPage({ url: 'http://127.0.0.1:9350/' });
  const reviewer1 = makeReviewerPage({ url: 'https://chatgpt.com/c/reviewer-1' });
  const reviewer2 = makeReviewerPage({ url: 'https://chatgpt.com/c/reviewer-2' });
  const context = { pages: () => [coordinator, reviewer1, reviewer2] };
  const budget = await ensureBrowserPageBudget(context, {
    coordinatorPage: coordinator,
    reviewerPages: [reviewer1, reviewer2],
  });
  assert.equal(budget.ok, true);
  assert.equal(budget.automationTabCount, 3);
  assert.equal(budget.reviewerTabCount, 2);
});

test('browser page budget rejects a fourth automation tab and third reviewer tab', async () => {
  const coordinator = makeReviewerPage({ url: 'http://127.0.0.1:9350/' });
  const reviewers = [1, 2, 3].map(id => makeReviewerPage({ url: `https://chatgpt.com/c/reviewer-${id}` }));
  const context = { pages: () => [coordinator, ...reviewers] };
  const budget = await ensureBrowserPageBudget(context, {
    coordinatorPage: coordinator,
    reviewerPages: reviewers,
  });
  assert.equal(budget.ok, false);
  assert.equal(budget.automationTabCount, 4);
  assert.equal(budget.reviewerTabCount, 3);
  assert.match(budget.reason, /reviewer tab cap exceeded/);
});
