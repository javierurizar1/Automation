import fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_NAMES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache', 'Media Cache',
  'CacheStorage', 'ScriptCache',
]);
const EPHEMERAL_NAMES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'LOCK', 'lockfile']);

async function includeEntry(sourceRoot, profileName, sourcePath) {
  const relative = path.relative(sourceRoot, sourcePath);
  if (!relative) return true;
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;

  const parts = relative.split(path.sep);
  if (parts.some(part => CACHE_NAMES.has(part) || EPHEMERAL_NAMES.has(part)
    || part.startsWith('Singleton') || part.startsWith('DevToolsActivePort'))) return false;
  if (parts.length === 1 && !['Local State', 'First Run', 'Last Version', 'Variations', profileName].includes(parts[0])) return false;
  if (parts[0] !== profileName && parts[0] !== 'Local State' && parts[0] !== 'First Run'
    && parts[0] !== 'Last Version' && parts[0] !== 'Variations') return false;

  try {
    const metadata = await fs.lstat(sourcePath);
    return !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function main() {
  const [sourceArg, destinationArg, profileNameArg] = process.argv.slice(2);
  if (!sourceArg || !destinationArg || !profileNameArg) throw new Error('source, destination, and profile directory are required');
  const sourceRoot = path.resolve(sourceArg);
  const destination = path.resolve(destinationArg);
  const profileName = String(profileNameArg);
  if (sourceRoot === destination || destination.startsWith(`${sourceRoot}${path.sep}`)
    || sourceRoot.startsWith(`${destination}${path.sep}`)) {
    throw new Error('source and destination profile directories must be separate');
  }
  if (!/^[^\\/]{1,100}$/.test(profileName) || profileName === '.' || profileName === '..') {
    throw new Error('invalid profile directory name');
  }

  const sourceProfile = path.join(sourceRoot, profileName);
  const sourceLocalState = path.join(sourceRoot, 'Local State');
  const sourceProfileMetadata = await fs.stat(sourceProfile).catch(() => null);
  const sourceStateMetadata = await fs.stat(sourceLocalState).catch(() => null);
  if (!sourceProfileMetadata?.isDirectory() || !sourceStateMetadata?.isFile()) {
    throw new Error('source does not contain Local State and the selected browser profile');
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(sourceRoot, destination, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
    filter: sourcePath => includeEntry(sourceRoot, profileName, sourcePath),
  });
}

main().catch(error => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
