import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function isCachedSource(root) {
  const parts = path.resolve(root).replaceAll('\\', '/').toLowerCase().split('/');
  return (
    parts.at(-1) === 'source' &&
    ['windows', 'macos'].includes(parts.at(-2)) &&
    parts.at(-3) === 'work' &&
    parts.at(-4) === '.cache'
  );
}

export function assertBuildRoot(root) {
  if (isCachedSource(root)) {
    throw new Error('Run the unified build from the original repository, not its cached source.');
  }
}

export function buildEnvironment(root = projectRoot, base = process.env) {
  const workRoot =
    base.OPENVPN_BUILD_WORK_ROOT || (isCachedSource(root) ? path.dirname(root) : null);
  const cache = workRoot || path.join(root, '.cache');
  const temporary = path.join(cache, 'tmp');
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  return {
    ...base,
    ...(workRoot ? { OPENVPN_BUILD_WORK_ROOT: workRoot } : {}),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    SWC_NATIVE_BINDING_CACHE: path.join(cache, 'swc'),
    npm_config_cache: path.join(cache, 'npm'),
    CARGO_TARGET_DIR: path.join(cache, 'cargo-target'),
  };
}

export async function createTempDirectory(prefix, root = projectRoot) {
  const directory = path.join(root, '.cache/tmp');
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  return fs.promises.mkdtemp(path.join(directory, prefix));
}

export function prepareTauriLayout(root = projectRoot) {
  const destination = path.join(root, '.cache/tauri/gen');
  const alias = path.join(root, 'ui/src-tauri/gen');
  fs.mkdirSync(destination, { recursive: true });
  // Tauri hardcodes gen/schemas. Keep its required alias while storing all
  // generated files in the cache. Windows junctions need no developer mode.
  const existing = fs.lstatSync(alias, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isSymbolicLink() || fs.realpathSync(alias) !== fs.realpathSync(destination)) {
      throw new Error(`Move the existing Tauri generated directory into ${destination}: ${alias}`);
    }
  } else {
    fs.symlinkSync(destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
