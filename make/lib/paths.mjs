import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function buildEnvironment(root = projectRoot, base = process.env) {
  const temporary = path.join(root, '.cache/tmp');
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  return {
    ...base,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    SWC_NATIVE_BINDING_CACHE: path.join(root, '.cache/swc'),
    npm_config_cache: path.join(root, '.cache/npm'),
    CARGO_TARGET_DIR: path.join(root, '.cache/cargo-target'),
  };
}

export async function createTempDirectory(prefix, root = projectRoot) {
  const directory = path.join(root, '.cache/tmp');
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  return fs.promises.mkdtemp(path.join(directory, prefix));
}

export function prepareTauriLayout(root = projectRoot) {
  const destination = path.join(root, '.cache/tauri/gen');
  const alias = path.join(root, 'src-tauri/gen');
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
