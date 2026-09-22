import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright-core';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45000;
const DEFAULT_RETRY_INTERVAL_MS = 500;
const MAX_CANDIDATES = 6;
const PROFILE_COPY_TIMEOUT_MS = 30000;
const PROFILE_BOOTSTRAP_SCRIPT = fileURLToPath(new URL('./browser-profile-bootstrap.mjs', import.meta.url));
// Playwright waits for a first committed navigation when attaching to a
// persistent Chromium context. The dashboard owns this local HTTP endpoint so
// the browser gets a real committed document before the controller navigates
// the same visible authenticated profile to ChatGPT.
export const AUTOMATION_BOOTSTRAP_URL = 'http://127.0.0.1:9350/__r433_bootstrap';
const EPHEMERAL_PROFILE_NAMES = new Set([
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'LOCK', 'lockfile',
]);

function boundedMs(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), maximum) : fallback;
}

function unique(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function isChromiumExecutable(candidate) {
  const basename = path.basename(candidate).toLowerCase().replace(/\s+/g, '-');
  return /(?:^|[-_.])(chrome|chromium|brave|msedge|edge)(?:$|[-_.])/i.test(basename)
    || /^(chrome|chromium|brave|msedge|edge)(?:\.exe)?$/i.test(basename);
}

function knownExecutablePaths(platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.flatMap(root => [
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      ]),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [];
}

function browserFamily(value) {
  const basename = path.basename(String(value || '')).toLowerCase().replace(/\s+/g, '-');
  if (basename.includes('brave')) return 'brave';
  if (basename.includes('chromium')) return 'chromium';
  if (basename.includes('msedge') || basename.includes('edge')) return 'edge';
  if (basename.includes('chrome')) return 'chrome';
  return null;
}

function isFirefoxExecutable(candidate) {
  return /(?:^|[-_.])firefox(?:$|[-_.])/i.test(path.basename(String(candidate || '')));
}

function defaultFirefoxProfileDirectory({ platform = process.platform, env = process.env } = {}) {
  const home = env.HOME || env.USERPROFILE;
  if (!home) return path.join(process.cwd(), 'data', 'firefox-profile');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'R433-Firefox-Fallback');
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(local, 'R433-Firefox-Fallback');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'R433-Firefox-Fallback');
}

const BROWSER_PROFILE_MODES = new Set(['source', 'clone']);

/**
 * Normalize the profile mode used for a browser launch. Source mode is the
 * production default so an authenticated browser identity is never silently
 * copied into a new automation identity.
 */
export function normalizeBrowserProfileMode(value = 'source') {
  const mode = String(value ?? 'source').trim().toLowerCase() || 'source';
  if (!BROWSER_PROFILE_MODES.has(mode)) {
    throw codedError('BROWSER_PROFILE_MODE_INVALID', `Unsupported browser profile mode: ${mode}`);
  }
  return mode;
}

function defaultBrowserDataDirectories({ platform = process.platform, env = process.env } = {}) {
  const home = env.HOME || env.USERPROFILE;
  if (!home) return [];
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
    return [
      { family: 'brave', path: path.join(configHome, 'BraveSoftware', 'Brave-Browser') },
      { family: 'chrome', path: path.join(configHome, 'google-chrome') },
      { family: 'chromium', path: path.join(configHome, 'chromium') },
      { family: 'edge', path: path.join(configHome, 'microsoft-edge') },
    ];
  }
  if (platform === 'darwin') {
    return [
      { family: 'brave', path: path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser') },
      { family: 'chrome', path: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome') },
      { family: 'chromium', path: path.join(home, 'Library', 'Application Support', 'Chromium') },
      { family: 'edge', path: path.join(home, 'Library', 'Application Support', 'Microsoft Edge') },
    ];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      { family: 'brave', path: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { family: 'chrome', path: path.join(local, 'Google', 'Chrome', 'User Data') },
      { family: 'chromium', path: path.join(local, 'Chromium', 'User Data') },
      { family: 'edge', path: path.join(local, 'Microsoft', 'Edge', 'User Data') },
    ];
  }
  return [];
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isDefaultBrowserDataDirectory(profileDir, options = {}) {
  return defaultBrowserDataDirectories(options).find(candidate => samePath(candidate.path, profileDir)) || null;
}

function linuxProfileUse(sourceProfileDir, family, profileDirectoryName, procRoot = '/proc', staleLockMaxAgeMs = 15 * 60 * 1000, {
  ignoreRegularLocks = false,
  platform = process.platform,
  env = process.env,
} = {}) {
  let entries;
  try {
    entries = fs.readdirSync(procRoot).filter(entry => /^\d+$/.test(entry));
  } catch (error) {
    return { state: 'UNKNOWN', reason: `cannot inspect process table: ${error.message || error}` };
  }
  if (entries.length > 4096) return { state: 'UNKNOWN', reason: 'process table exceeds safe inspection limit' };

  const source = path.resolve(sourceProfileDir);
  const expectedLockPaths = [path.join(source, 'SingletonLock'), path.join(source, profileDirectoryName, 'LOCK')];
  for (const lockPath of expectedLockPaths) {
    try {
      const lock = fs.lstatSync(lockPath);
      if (!lock.isSymbolicLink()) {
        const lockAgeMs = Math.max(0, Date.now() - lock.mtimeMs);
        if (!ignoreRegularLocks && lockAgeMs < staleLockMaxAgeMs) {
          return { state: 'IN_USE', reason: 'browser profile lock is recent' };
        }
        continue;
      }
      const target = fs.readlinkSync(lockPath);
      const match = target.match(/(?:^|[-_])(\d+)$/);
      if (!match) return { state: 'UNKNOWN', reason: 'browser profile lock owner could not be identified' };
      try {
        process.kill(Number(match[1]), 0);
        return { state: 'IN_USE', reason: 'browser profile lock owner is still running' };
      } catch (error) {
        if (error.code !== 'ESRCH') return { state: 'UNKNOWN', reason: 'browser profile lock owner could not be checked' };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return { state: 'UNKNOWN', reason: 'browser profile lock could not be inspected' };
    }
  }

  for (const entry of entries) {
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let commandLine;
    try {
      commandLine = fs.readFileSync(path.join(procRoot, entry, 'cmdline'))
        .toString('utf8').split('\0').filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      try {
        if (fs.statSync(path.join(procRoot, entry)).uid === process.getuid?.()) {
          return { state: 'UNKNOWN', reason: 'same-user process could not be inspected safely' };
        }
      } catch {}
      continue;
    }
    if (!commandLine.length) continue;
    const hasExplicitProfile = commandLine.some((argument, index) => {
      if (argument.startsWith('--user-data-dir=')) return samePath(argument.slice('--user-data-dir='.length), source);
      return argument === '--user-data-dir' && commandLine[index + 1] && samePath(commandLine[index + 1], source);
    });
    if (hasExplicitProfile) return { state: 'IN_USE', pid, reason: 'browser process uses the source profile directory' };
    const hasUserDataArgument = commandLine.some(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='));
    if (!hasUserDataArgument && browserFamily(commandLine[0]) === family) {
      // Infer the implicit default profile from the browser process's own
      // environment. The caller may intentionally be checking an isolated
      // profile under a different HOME (as the bootstrap tests do), and an
      // unrelated browser must not block that profile.
      let processEnv = null;
      try {
        const rawEnv = fs.readFileSync(path.join(procRoot, entry, 'environ')).toString('utf8');
        processEnv = Object.fromEntries(rawEnv.split('\0').filter(Boolean).map(value => {
          const separator = value.indexOf('=');
          return separator < 0 ? [value, ''] : [value.slice(0, separator), value.slice(separator + 1)];
        }));
      } catch {}
      const processDefaultDirectory = defaultBrowserDataDirectories({
        platform,
        env: processEnv || process.env,
      }).find(candidate => candidate.family === family);
      if (processDefaultDirectory && samePath(processDefaultDirectory.path, source)) {
        return { state: 'IN_USE', pid, reason: 'browser process may be using its default source profile' };
      }
    }
  }
  return { state: 'IDLE' };
}

function removeDestinationEphemeralFiles(profileDir, profileDirectoryName = 'Default') {
  const roots = [path.resolve(profileDir), path.join(path.resolve(profileDir), profileDirectoryName)];
  const removed = [];
  for (const root of roots) {
    for (const name of EPHEMERAL_PROFILE_NAMES) {
      const candidate = path.join(root, name);
      try {
        const metadata = fs.lstatSync(candidate);
        if (metadata.isDirectory()) continue;
        fs.unlinkSync(candidate);
        removed.push(candidate);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return removed;
}

/** Remove only ephemeral locks from an isolated automation profile after its owner stopped. */
export function cleanupAutomationProfileEphemeral({ profileDir, profileDirectoryName = 'Default' } = {}) {
  if (!profileDir) return [];
  return removeDestinationEphemeralFiles(profileDir, profileDirectoryName);
}

function processGroupId(pid, procRoot = '/proc') {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const match = stat.match(/^\d+ \(.+\)\s+\S+\s+\d+\s+(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + Math.max(100, Math.min(5000, Number(timeoutMs) || 2000));
  while (Date.now() < deadline) {
    try {
      process.kill(Number(pid), 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      return false;
    }
    await delay(50);
  }
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/**
 * Stop only a browser process group that this controller launched itself.
 * Ownership is proven from the live command line and detached process group;
 * a source profile or an externally attached CDP browser is never touched.
 */
export async function terminateOwnedBrowserProcessGroup({
  pid,
  profileDir,
  profileDirectoryName = 'Default',
  remoteDebuggingPort = null,
  cleanupEphemeral = true,
  platform = process.platform,
  procRoot = '/proc',
  timeoutMs = 2000,
} = {}) {
  const normalizedPid = Number(pid);
  if (platform !== 'linux' || !Number.isInteger(normalizedPid) || normalizedPid <= 1 || !profileDir) {
    return { attempted: false, stopped: false, reason: 'OWNERSHIP_UNVERIFIED' };
  }

  let commandLine;
  try {
    commandLine = fs.readFileSync(path.join(procRoot, String(normalizedPid), 'cmdline'))
      .toString('utf8').split('\0').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { attempted: true, stopped: true, alreadyExited: true, cleaned: [] };
    }
    return { attempted: false, stopped: false, reason: 'OWNERSHIP_UNVERIFIED' };
  }

  const expectedProfile = path.resolve(profileDir);
  const profileArgument = commandLine.find((argument, index) => {
    if (argument.startsWith('--user-data-dir=')) return samePath(argument.slice('--user-data-dir='.length), expectedProfile);
    return argument === '--user-data-dir' && commandLine[index + 1]
      && samePath(commandLine[index + 1], expectedProfile);
  });
  if (!profileArgument || processGroupId(normalizedPid, procRoot) !== normalizedPid) {
    return { attempted: false, stopped: false, reason: 'OWNERSHIP_UNVERIFIED' };
  }
  if (remoteDebuggingPort != null) {
    const expectedPort = String(remoteDebuggingPort);
    const hasExpectedPort = commandLine.some(argument => argument === `--remote-debugging-port=${expectedPort}`);
    if (!hasExpectedPort) return { attempted: false, stopped: false, reason: 'OWNERSHIP_UNVERIFIED' };
  }

  try {
    process.kill(-normalizedPid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') return { attempted: true, stopped: false, reason: 'TERMINATE_FAILED' };
  }
  let stopped = await waitForProcessExit(normalizedPid, timeoutMs);
  if (!stopped) {
    try { process.kill(-normalizedPid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') return { attempted: true, stopped: false, reason: 'TERMINATE_FAILED' };
    }
    stopped = await waitForProcessExit(normalizedPid, timeoutMs);
  }
  if (!stopped) return { attempted: true, stopped: false, reason: 'TERMINATE_TIMEOUT' };

  let cleaned = [];
  if (!cleanupEphemeral) return { attempted: true, stopped: true, cleaned };
  try {
    cleaned = cleanupAutomationProfileEphemeral({ profileDir: expectedProfile, profileDirectoryName });
  } catch {
    return { attempted: true, stopped: true, cleaned, reason: 'LOCK_CLEANUP_FAILED' };
  }
  return { attempted: true, stopped: true, cleaned };
}

function sourceFingerprint(profileDir, profileName) {
  const paths = [path.join(profileDir, 'Local State'), path.join(profileDir, profileName)];
  return paths.map(candidate => {
    try {
      const stat = fs.statSync(candidate);
      return `${candidate}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${candidate}:missing`;
    }
  }).join('|');
}

async function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onExit = (code, signal) => code === 0
      ? finish(null, { code, signal })
      : finish(new Error(`owned helper exited with code ${code}${signal ? ` (${signal})` : ''}`));
    const onError = error => finish(error);
    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimeout(() => {
      const error = new Error(`owned helper exceeded ${timeoutMs}ms deadline`);
      error.code = 'OWNED_HELPER_TIMEOUT';
      finish(error);
    }, timeoutMs);
  });
}

function profileHasRequiredFiles(profileDir, profileName) {
  try {
    return fs.statSync(path.join(profileDir, 'Local State')).isFile()
      && fs.statSync(path.join(profileDir, profileName)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validate a configured persistent browser profile without creating or
 * mutating it. Source mode must fail closed when another browser owns it.
 */
export function validateSourceBrowserProfile({
  profileDir,
  profileDirectoryName = 'Default',
  preferredExecutable = null,
  platform = process.platform,
  env = process.env,
  procRoot = '/proc',
  staleLockMaxAgeMs = 15 * 60 * 1000,
} = {}) {
  if (!profileDir) throw codedError('BROWSER_PROFILE_UNCONFIGURED', 'A persistent source browser profile is required');
  const profileName = String(profileDirectoryName || 'Default').trim();
  if (!/^[^\\/]{1,100}$/.test(profileName) || profileName === '.' || profileName === '..') {
    throw codedError('BROWSER_PROFILE_NAME_INVALID', 'Invalid browser profile directory name');
  }
  const sourceProfileDir = path.resolve(profileDir);
  if (!profileHasRequiredFiles(sourceProfileDir, profileName)) {
    throw codedError('BROWSER_PROFILE_SOURCE_INVALID', 'Source browser profile lacks Local State or the selected profile directory');
  }

  const defaultDirectory = isDefaultBrowserDataDirectory(sourceProfileDir, { platform, env });
  const family = defaultDirectory?.family || browserFamily(preferredExecutable);
  if (platform === 'linux') {
    const use = linuxProfileUse(
      sourceProfileDir,
      family || 'chromium',
      profileName,
      procRoot,
      staleLockMaxAgeMs,
      { platform, env },
    );
    if (use.state !== 'IDLE') {
      throw codedError('BROWSER_PROFILE_IN_USE', `Source browser profile is in use or cannot be checked (${use.reason || use.state})`);
    }
  } else {
    const lockPaths = [
      path.join(sourceProfileDir, 'SingletonLock'),
      path.join(sourceProfileDir, profileName, 'LOCK'),
    ];
    if (lockPaths.some(candidate => fs.existsSync(candidate))) {
      throw codedError('BROWSER_PROFILE_IN_USE', 'Source browser profile has an active ownership lock');
    }
  }
  return {
    profileDir: sourceProfileDir,
    profileDirectoryName: profileName,
    profileMode: 'source',
    family: family || null,
  };
}

/**
 * Validate the dedicated Firefox fallback profile without creating or
 * mutating it. Firefox uses parent.lock rather than Chromium's SingletonLock.
 * A live owner is rejected so a human Firefox session is never joined or
 * overwritten by the automation fallback.
 */
export function validateFirefoxProfileDirectory({
  profileDir,
  platform = process.platform,
  procRoot = '/proc',
} = {}) {
  if (!profileDir) throw codedError('FIREFOX_PROFILE_UNCONFIGURED', 'Firefox fallback profile directory is required');
  const resolved = path.resolve(profileDir);
  const lockNames = platform === 'win32' ? ['parent.lock', 'lock'] : ['parent.lock', '.parentlock', 'lock'];
  if (lockNames.some(name => fs.existsSync(path.join(resolved, name)))) {
    throw codedError('FIREFOX_PROFILE_IN_USE', 'Firefox fallback profile has an active ownership lock');
  }
  if (platform === 'linux') {
    let entries;
    try {
      entries = fs.readdirSync(procRoot).filter(entry => /^\d+$/.test(entry));
    } catch (error) {
      throw codedError('FIREFOX_PROFILE_UNVERIFIED', `Firefox profile ownership could not be checked: ${error.message || error}`);
    }
    if (entries.length > 4096) throw codedError('FIREFOX_PROFILE_UNVERIFIED', 'process table exceeds safe inspection limit');
    for (const entry of entries) {
      if (Number(entry) === process.pid) continue;
      let commandLine;
      try {
        commandLine = fs.readFileSync(path.join(procRoot, entry, 'cmdline'))
          .toString('utf8').split('\0').filter(Boolean);
      } catch (error) {
        if (error.code !== 'ENOENT') continue;
        continue;
      }
      const hasProfile = commandLine.some((argument, index) => {
        if ((argument === '-profile' || argument === '--profile') && commandLine[index + 1]) {
          return samePath(commandLine[index + 1], resolved);
        }
        return argument.startsWith('-profile=') && samePath(argument.slice('-profile='.length), resolved);
      });
      if (hasProfile) {
        throw codedError('FIREFOX_PROFILE_IN_USE', `Firefox fallback profile is in use by process ${entry}`);
      }
    }
  }
  return { profileDir: resolved, profileMode: 'firefox' };
}

/** Copy an authenticated default browser profile once into the ignored local automation profile. */
export async function bootstrapAutomationProfile({
  profileDir,
  profileDirectoryName = 'Default',
  projectRoot = process.cwd(),
  platform = process.platform,
  env = process.env,
  timeoutMs = PROFILE_COPY_TIMEOUT_MS,
  procRoot = '/proc',
  staleLockMaxAgeMs = 15 * 60 * 1000,
} = {}) {
  if (!profileDir) throw codedError('BROWSER_PROFILE_UNCONFIGURED', 'Browser user-data directory is required');
  const defaultDirectory = isDefaultBrowserDataDirectory(profileDir, { platform, env });
  if (!defaultDirectory) {
    return { profileDir: path.resolve(profileDir), profileDirectoryName, bootstrapped: false, reused: false };
  }
  if (platform !== 'linux') {
    throw codedError('BROWSER_PROFILE_BOOTSTRAP_UNSUPPORTED', 'Safe source-profile process checks are supported only on Linux');
  }

  const profileName = String(profileDirectoryName || 'Default').trim();
  if (!/^[^\\/]{1,100}$/.test(profileName) || profileName === '.' || profileName === '..') {
    throw codedError('BROWSER_PROFILE_NAME_INVALID', 'Invalid browser profile directory name');
  }
  const sourceProfileDir = path.resolve(profileDir);
  const profileRoot = path.join(projectRoot, 'data', 'browser-profile');
  const automationProfileDir = path.join(profileRoot, `${defaultDirectory.family}-automation`);
  const markerPath = path.join(profileRoot, `.${defaultDirectory.family}-automation-${profileName}.initialized.json`);

  if (fs.existsSync(automationProfileDir)) {
    if (!profileHasRequiredFiles(automationProfileDir, profileName)) {
      throw codedError('BROWSER_PROFILE_BOOTSTRAP_INCOMPLETE', 'Existing automation profile is incomplete; it will not be overwritten');
    }
    // A retained automation profile may contain a regular lock left by an
    // owned browser that has already stopped. Ignore regular lock age only
    // after process inspection, then remove those ephemeral files. Symlink
    // locks and live browser processes still fail closed.
    const use = linuxProfileUse(
      automationProfileDir,
      defaultDirectory.family,
      profileName,
      procRoot,
      staleLockMaxAgeMs,
      { ignoreRegularLocks: true, platform, env },
    );
    if (use.state !== 'IDLE') {
      throw codedError('BROWSER_PROFILE_IN_USE', `Automation profile is in use or cannot be checked (${use.reason || use.state})`);
    }
    removeDestinationEphemeralFiles(automationProfileDir, profileName);
    if (!fs.existsSync(markerPath)) {
      writeBootstrapMarker(markerPath, profileName, defaultDirectory.family);
    }
    return { profileDir: automationProfileDir, profileDirectoryName: profileName, bootstrapped: false, reused: true };
  }

  const sourceUse = linuxProfileUse(
    sourceProfileDir,
    defaultDirectory.family,
    profileName,
    procRoot,
    staleLockMaxAgeMs,
    { platform, env },
  );
  if (sourceUse.state !== 'IDLE') {
    throw codedError('BROWSER_PROFILE_IN_USE', `Default source profile is in use or cannot be checked (${sourceUse.reason || sourceUse.state})`);
  }
  if (!profileHasRequiredFiles(sourceProfileDir, profileName)) {
    throw codedError('BROWSER_PROFILE_SOURCE_INVALID', 'Default source profile lacks Local State or the selected profile directory');
  }
  const sourceBeforeCopy = sourceFingerprint(sourceProfileDir, profileName);

  const boundedTimeoutMs = boundedMs(timeoutMs, PROFILE_COPY_TIMEOUT_MS, 45000);
  fs.mkdirSync(profileRoot, { recursive: true });
  const stagingDir = path.join(profileRoot, `.staging-${defaultDirectory.family}-${process.pid}-${randomUUID()}`);
  const child = spawn(process.execPath, [PROFILE_BOOTSTRAP_SCRIPT, sourceProfileDir, stagingDir, profileName], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
    env,
  });
  try {
    await waitForChildExit(child, boundedTimeoutMs);
    const sourceUseAfterCopy = linuxProfileUse(
      sourceProfileDir,
      defaultDirectory.family,
      profileName,
      procRoot,
      staleLockMaxAgeMs,
      { platform, env },
    );
    if (sourceUseAfterCopy.state !== 'IDLE') {
      throw codedError('BROWSER_PROFILE_SOURCE_CHANGED', `Source profile became active during bootstrap (${sourceUseAfterCopy.reason || sourceUseAfterCopy.state})`);
    }
    if (sourceFingerprint(sourceProfileDir, profileName) !== sourceBeforeCopy) {
      throw codedError('BROWSER_PROFILE_SOURCE_CHANGED', 'Source profile metadata changed during bootstrap');
    }
    if (!profileHasRequiredFiles(stagingDir, profileName)) {
      throw codedError('BROWSER_PROFILE_BOOTSTRAP_INCOMPLETE', 'Copied automation profile failed validation');
    }
    fs.renameSync(stagingDir, automationProfileDir);
    writeBootstrapMarker(markerPath, profileName, defaultDirectory.family);
    return { profileDir: automationProfileDir, profileDirectoryName: profileName, bootstrapped: true, reused: false };
  } catch (error) {
    if (error?.code === 'OWNED_HELPER_TIMEOUT') await terminateOwnedProcess(child, platform);
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    if (error?.code === 'OWNED_HELPER_TIMEOUT') {
      throw codedError('BROWSER_PROFILE_BOOTSTRAP_TIMEOUT', `Profile bootstrap exceeded ${boundedTimeoutMs}ms`, []);
    }
    throw error;
  }
}

function writeBootstrapMarker(markerPath, profileDirectoryName, family) {
  const marker = `${JSON.stringify({ schemaVersion: 1, family, profileDirectoryName, createdAt: new Date().toISOString() })}\n`;
  const temporary = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, marker, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporary, markerPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
  }
}

/** Return installed Chromium-family executables in deterministic preference order. */
export function discoverChromiumCandidates({
  preferredExecutable = null,
  candidateExecutables = [],
  platform = process.platform,
  env = process.env,
  lookupTimeoutMs = 2500,
} = {}) {
  const commandNames = platform === 'win32'
    ? ['chrome.exe', 'chromium.exe', 'brave.exe', 'msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable', 'chrome'];
  let pathCandidates = [];
  try {
    const locator = platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(locator, platform === 'win32' ? commandNames : ['-a', ...commandNames], {
      encoding: 'utf8',
      timeout: boundedMs(lookupTimeoutMs, 2500, 5000),
      windowsHide: true,
      env,
    });
    if (result.status === 0) pathCandidates = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {}

  const existingPaths = knownExecutablePaths(platform, env).filter(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  const explicitCandidates = Array.isArray(candidateExecutables) ? candidateExecutables : [];
  const ordered = unique([preferredExecutable, ...explicitCandidates, ...existingPaths, ...pathCandidates]);
  return ordered.filter(candidate => {
    if (!isChromiumExecutable(candidate)) return false;
    if (candidate.includes(path.sep) || (platform === 'win32' && candidate.includes('/'))) {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    }
    return true;
  }).slice(0, MAX_CANDIDATES);
}

/** Return installed Firefox executables in deterministic preference order. */
export function discoverFirefoxCandidates({
  preferredExecutable = null,
  candidateExecutables = [],
  platform = process.platform,
  env = process.env,
  lookupTimeoutMs = 2500,
} = {}) {
  const commandNames = platform === 'win32' ? ['firefox.exe'] : ['firefox', 'firefox-esr'];
  let pathCandidates = [];
  try {
    const locator = platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(locator, platform === 'win32' ? commandNames : ['-a', ...commandNames], {
      encoding: 'utf8',
      timeout: boundedMs(lookupTimeoutMs, 2500, 5000),
      windowsHide: true,
      env,
    });
    if (result.status === 0) {
      pathCandidates = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }
  } catch {}

  const knownPaths = platform === 'win32'
    ? [
      path.join(env.PROGRAMFILES || '', 'Mozilla Firefox', 'firefox.exe'),
      path.join(env['PROGRAMFILES(X86)'] || '', 'Mozilla Firefox', 'firefox.exe'),
    ]
    : platform === 'darwin'
      ? ['/Applications/Firefox.app/Contents/MacOS/firefox']
      : ['/usr/bin/firefox', '/usr/bin/firefox-esr', '/usr/local/bin/firefox'];
  const ordered = unique([preferredExecutable, ...candidateExecutables, ...knownPaths, ...pathCandidates]);
  return ordered.filter(candidate => {
    if (!isFirefoxExecutable(candidate)) return false;
    if (candidate.includes(path.sep) || (platform === 'win32' && candidate.includes('/'))) {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    }
    return true;
  }).slice(0, MAX_CANDIDATES);
}

function codedError(code, message, attempts = []) {
  const error = new Error(message);
  error.code = code;
  error.attempts = attempts;
  return error;
}

async function connectOnce(playwrightChromium, endpoint, timeoutMs) {
  return playwrightChromium.connectOverCDP(endpoint, { timeout: timeoutMs });
}

/**
 * Launch a visible persistent context with a finite deadline. This is the
 * recovery path for Chromium builds whose already-loaded page cannot be
 * adopted by Playwright's CDP transport. The promise is kept attached after
 * a timeout so a late browser launch is closed rather than leaked.
 */
async function launchPersistentContextBounded(playwrightChromium, userDataDir, options, timeoutMs) {
  const launcher = playwrightChromium?.launchPersistentContext;
  if (typeof launcher !== 'function') {
    throw codedError('BROWSER_PERSISTENT_UNSUPPORTED', 'Playwright persistent context launch is unavailable');
  }
  const boundedTimeoutMs = boundedMs(timeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 30000);
  let timer;
  let pending;
  try {
    pending = Promise.resolve().then(() => launcher.call(playwrightChromium, userDataDir, options));
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(codedError(
        'BROWSER_STARTUP_TIMEOUT',
        `persistent browser launch exceeded ${boundedTimeoutMs}ms`,
      )), boundedTimeoutMs);
    });
    return await Promise.race([pending, timeout]);
  } catch (error) {
    // A Playwright launch can resolve after our deadline. Close that context
    // when it arrives, but never touch a browser we did not launch here.
    pending?.then(context => context?.close?.()).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp(playwrightChromium, endpoint, child, deadline, retryIntervalMs, connectTimeoutMs, attempts) {
  let lastError = null;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      lastError = new Error(`browser process exited with code ${child.exitCode}`);
      break;
    }
    const remainingMs = deadline - Date.now();
    try {
      const browser = await connectOnce(playwrightChromium, endpoint, Math.max(100, Math.min(connectTimeoutMs, remainingMs)));
      const context = browser.contexts()[0] || null;
      if (!context) throw new Error('CDP connected without a browser context');
      return { browser, context };
    } catch (error) {
      lastError = error;
      attempts.push({ phase: child ? 'launched-cdp-attach' : 'existing-cdp-attach', error: error.message || String(error) });
    }
    const pauseMs = Math.min(retryIntervalMs, Math.max(0, deadline - Date.now()));
    if (pauseMs) await delay(pauseMs);
  }
  throw lastError || new Error('browser startup deadline elapsed before CDP became available');
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const finish = value => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
  });
}

async function terminateOwnedProcess(child, platform = process.platform) {
  if (!child || child.exitCode !== null) return true;
  try {
    if (platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 });
    } else if (child.pid && child.__codexDetached) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
  if (await waitForExit(child, 1200)) return true;
  try {
    if (platform !== 'win32' && child.pid && child.__codexDetached) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {}
  return waitForExit(child, 1200);
}

/**
 * Attach to an existing CDP session first. If it is unavailable, start an
 * installed Chromium-family browser with the same persistent profile and
 * attach to its configured CDP port. All attempts have finite deadlines.
 */
export async function connectOrLaunchBrowser({
  endpoint: configuredEndpoint = null,
  cdpPort = null,
  preferredExecutable = null,
  profileDir = null,
  profileMode = 'source',
  projectRoot = process.cwd(),
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  candidateExecutables = [],
  profileDirectoryName = null,
  playwrightChromium = chromium,
  playwrightFirefox = firefox,
  firefoxExecutable = null,
  firefoxCandidates = [],
  firefoxProfileDir = null,
  firefoxFallbackEnabled = false,
  platform = process.platform,
  env = process.env,
} = {}) {
  const selectedProfileMode = normalizeBrowserProfileMode(profileMode);
  const connectMs = boundedMs(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 15000);
  const startupMs = boundedMs(startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 30000);
  const retryMs = boundedMs(retryIntervalMs, DEFAULT_RETRY_INTERVAL_MS, 3000);
  const endpoint = configuredEndpoint || (Number.isInteger(Number(cdpPort)) && Number(cdpPort) > 0
    ? `http://127.0.0.1:${Number(cdpPort)}`
    : null);
  if (!endpoint) throw codedError('BROWSER_UNAVAILABLE', 'CDP endpoint or valid port is required');

  const attempts = [];
  try {
    const connected = await connectOnce(playwrightChromium, endpoint, connectMs);
    const context = connected.contexts()[0] || null;
    if (context) {
      return {
        ...connected,
        context,
        executable: null,
        pid: null,
        endpoint,
        launched: false,
        profileDir: null,
        profileMode: selectedProfileMode,
      };
    }
    attempts.push({ phase: 'existing-cdp-attach', error: 'connected browser has no context' });
  } catch (error) {
    attempts.push({ phase: 'existing-cdp-attach', error: error.message || String(error) });
  }

  const candidates = discoverChromiumCandidates({ preferredExecutable, candidateExecutables, platform, env });
  if (!candidates.length) attempts.push({ phase: 'chromium-discovery', error: 'No installed supported Chromium browser was found' });

  // Match the historical Start-Controller profile location unless an explicit
  // profile is configured. Source mode never clears, recreates, or rotates
  // this profile; clone mode is an explicit opt-in for an isolated copy.
  const persistentProfileDir = path.resolve(profileDir || path.join(projectRoot, 'chrome-profile'));
  const selectedProfileDirectoryName = profileDirectoryName == null || String(profileDirectoryName).trim() === ''
    ? null
    : String(profileDirectoryName).trim();
  if (selectedProfileDirectoryName
    && (selectedProfileDirectoryName.length > 100 || /[\\/]/.test(selectedProfileDirectoryName)
      || selectedProfileDirectoryName === '.' || selectedProfileDirectoryName === '..')) {
    throw codedError('BROWSER_UNAVAILABLE', 'Invalid browser profile directory name', attempts);
  }
  let launchProfileDir = persistentProfileDir;
  let launchProfileName = selectedProfileDirectoryName || 'Default';
  let sourceProfileError = null;
  if (selectedProfileMode === 'source') {
    try {
      const source = validateSourceBrowserProfile({
        profileDir: persistentProfileDir,
        profileDirectoryName: launchProfileName,
        preferredExecutable: preferredExecutable || null,
        platform,
        env,
      });
      launchProfileDir = source.profileDir;
      launchProfileName = source.profileDirectoryName;
    } catch (error) {
      if (error?.code === 'BROWSER_PROFILE_MODE_INVALID'
        || error?.code === 'BROWSER_PROFILE_UNCONFIGURED'
        || error?.code === 'BROWSER_PROFILE_NAME_INVALID'
        || !firefoxFallbackEnabled) throw error;
      sourceProfileError = error;
      attempts.push({ phase: 'source-profile-validation', error: error.message || String(error) });
    }
  } else {
    try {
      const bootstrap = await bootstrapAutomationProfile({
        profileDir: persistentProfileDir,
        profileDirectoryName: launchProfileName,
        projectRoot,
        platform,
        env,
        timeoutMs: Math.min(PROFILE_COPY_TIMEOUT_MS, startupMs),
      });
      launchProfileDir = bootstrap.profileDir;
      launchProfileName = bootstrap.profileDirectoryName;
    } catch (error) {
      if (error?.code === 'BROWSER_PROFILE_BOOTSTRAP_UNSUPPORTED'
        || error?.code === 'BROWSER_PROFILE_UNCONFIGURED') throw error;
      throw codedError('BROWSER_UNAVAILABLE', `Browser profile bootstrap failed: ${error.message || error}`, attempts);
    }
    try {
      fs.mkdirSync(launchProfileDir, { recursive: true });
    } catch (error) {
      throw codedError('BROWSER_UNAVAILABLE', `Persistent browser profile is unavailable: ${error.message || error}`, attempts);
    }
  }
  let port;
  try {
    port = Number(new URL(endpoint).port || cdpPort);
  } catch {
    throw codedError('BROWSER_UNAVAILABLE', `Invalid CDP endpoint: ${endpoint}`, attempts);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw codedError('BROWSER_UNAVAILABLE', `Invalid CDP port in endpoint: ${endpoint}`, attempts);
  }

  // CDP attach remains the first choice. If it failed after the source profile
  // was proven idle, launchPersistentContext gives Playwright a direct pipe to
  // a fresh visible page and avoids waiting on a malformed already-loaded CRPage
  // target. Source mode is intentionally the only mode eligible for this path:
  // it never races an external profile owner and never deletes profile files.
  if (!sourceProfileError
    && candidates.length
    && selectedProfileMode === 'source'
    && typeof playwrightChromium?.launchPersistentContext === 'function') {
    for (const executable of candidates) {
      const persistentArgs = [
        `--profile-directory=${launchProfileName}`,
        '--no-first-run',
        '--no-default-browser-check',
        AUTOMATION_BOOTSTRAP_URL,
      ];
      try {
        const context = await launchPersistentContextBounded(
          playwrightChromium,
          launchProfileDir,
          {
            headless: false,
            executablePath: executable,
            timeout: startupMs,
            viewport: null,
            args: persistentArgs,
            env,
          },
          startupMs,
        );
        const browser = context?.browser?.() || null;
        if (!context || !browser) {
          try { await context?.close?.(); } catch {}
          throw new Error('persistent browser launch returned no browser context');
        }
        return {
          browser,
          context,
          executable,
          pid: null,
          endpoint,
          launched: true,
          profileDir: launchProfileDir,
          profileDirectoryName: launchProfileName,
          profileMode: selectedProfileMode,
          transport: 'persistent',
        };
      } catch (error) {
        attempts.push({ phase: 'persistent-browser-launch', executable, error: error.message || String(error) });
      }
    }
  }

  if (!sourceProfileError || selectedProfileMode === 'clone') {
    for (const executable of candidates) {
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${launchProfileDir}`,
        ...(launchProfileName ? [`--profile-directory=${launchProfileName}`] : []),
        '--no-first-run',
        '--no-default-browser-check',
        AUTOMATION_BOOTSTRAP_URL,
      ];
      let child;
      try {
        child = spawn(executable, args, { stdio: 'ignore', windowsHide: true, detached: true, env });
        child.__codexDetached = true;
      } catch (error) {
        attempts.push({ phase: 'browser-launch', executable, error: error.message || String(error) });
        continue;
      }
      const spawnError = new Promise(resolve => child.once('error', resolve));
      const deadline = Date.now() + startupMs;
      try {
        const attached = await Promise.race([
          waitForCdp(playwrightChromium, endpoint, child, deadline, retryMs, connectMs, attempts),
          spawnError.then(error => { throw error; }),
        ]);
        return {
          ...attached,
          executable,
          pid: child.pid || null,
          endpoint,
          launched: true,
          profileDir: launchProfileDir,
          profileDirectoryName: launchProfileName,
          profileMode: selectedProfileMode,
        };
      } catch (error) {
        attempts.push({ phase: 'browser-startup', executable, error: error.message || String(error) });
        const stopped = await terminateOwnedProcess(child);
        if (stopped && selectedProfileMode === 'clone') {
          try { removeDestinationEphemeralFiles(launchProfileDir, launchProfileName || 'Default'); } catch (cleanupError) {
            attempts.push({ phase: 'browser-cleanup', executable, error: cleanupError.message || String(cleanupError) });
          }
        }
        if (!stopped) {
          attempts.push({ phase: 'browser-cleanup', executable, error: 'failed browser process did not exit within cleanup deadline' });
          break;
        }
      }
    }
  }

  // Firefox is a final, explicit fallback. It uses a dedicated persistent
  // profile because Firefox cannot consume a Chromium user-data directory.
  // The profile is checked for ownership before it is created or opened, and
  // no Chromium profile or process is touched by this path.
  if (firefoxFallbackEnabled && typeof playwrightFirefox?.launchPersistentContext === 'function') {
    const firefoxProfile = path.resolve(firefoxProfileDir || defaultFirefoxProfileDirectory({ platform, env }));
    const firefoxBrowserCandidates = discoverFirefoxCandidates({
      preferredExecutable: firefoxExecutable,
      candidateExecutables: firefoxCandidates,
      platform,
      env,
    });
    if (!firefoxBrowserCandidates.length) {
      attempts.push({ phase: 'firefox-discovery', error: 'No installed Firefox browser was found' });
    } else {
      try {
        if (samePath(firefoxProfile, persistentProfileDir)) {
          throw codedError('FIREFOX_PROFILE_CONFLICT', 'Firefox fallback profile must be separate from the Chromium profile');
        }
        validateFirefoxProfileDirectory({ profileDir: firefoxProfile, platform });
        fs.mkdirSync(firefoxProfile, { recursive: true });
      } catch (error) {
        attempts.push({ phase: 'firefox-profile-validation', error: error.message || String(error) });
      }
      if (!attempts.some(attempt => attempt.phase === 'firefox-profile-validation')) {
        for (const executable of firefoxBrowserCandidates) {
          try {
            const context = await launchPersistentContextBounded(
              playwrightFirefox,
              firefoxProfile,
              {
                headless: false,
                executablePath: executable,
                timeout: startupMs,
                viewport: null,
                args: [AUTOMATION_BOOTSTRAP_URL],
                env,
              },
              startupMs,
            );
            const browser = context?.browser?.() || null;
            if (!context || !browser) {
              try { await context?.close?.(); } catch {}
              throw new Error('Firefox persistent launch returned no browser context');
            }
            return {
              browser,
              context,
              executable,
              pid: null,
              endpoint: null,
              launched: true,
              profileDir: firefoxProfile,
              profileDirectoryName: null,
              profileMode: 'firefox',
              transport: 'persistent-firefox',
            };
          } catch (error) {
            attempts.push({ phase: 'firefox-browser-launch', executable, error: error.message || String(error) });
          }
        }
      }
    }
  }

  throw codedError('BROWSER_UNAVAILABLE', 'All installed browser candidates failed within their startup deadlines', attempts);
}
