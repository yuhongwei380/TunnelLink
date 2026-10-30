import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function buildCacheRoot(root, base = process.env) {
  return base.TUNNEL_BUILD_CACHE_ROOT
    ? path.resolve(root, base.TUNNEL_BUILD_CACHE_ROOT)
    : path.join(root, '.cache');
}

export function buildEnvironment(root = projectRoot, base = process.env) {
  // Unified builds run from an isolated source checkout. Keep compiler and
  // download caches at the caller-provided project cache so tool-generated
  // paths do not gain another .cache/work/<platform>/source prefix.
  const cacheRoot = buildCacheRoot(root, base);
  const temporary = path.join(cacheRoot, 'tmp');
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  return {
    ...base,
    TUNNEL_BUILD_CACHE_ROOT: cacheRoot,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    SWC_NATIVE_BINDING_CACHE: path.join(cacheRoot, 'swc'),
    npm_config_cache: path.join(cacheRoot, 'npm'),
    CARGO_TARGET_DIR: path.join(cacheRoot, 'cargo-target'),
  };
}

export async function createTempDirectory(prefix, root = projectRoot) {
  const directory = path.join(buildCacheRoot(root), 'tmp');
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
