import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
const inheritedPath = process.env.PATH || process.env.Path || '';
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = path.dirname(process.execPath) + path.delimiter + inheritedPath;
// Support the project-local toolchain without changing the user's global PATH.
const localCargo = path.join(root, '.cache/rust/cargo');
if (
  fs.existsSync(path.join(localCargo, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'))
) {
  env.CARGO_HOME = localCargo;
  env.RUSTUP_HOME = path.join(root, '.cache/rust/rustup');
  env.PATH = path.join(localCargo, 'bin') + path.delimiter + env.PATH;
}
const args = process.argv.slice(2);
let command;
let commandArgs;
if (args[0] === 'cargo') {
  command = 'cargo';
  commandArgs = args.slice(1);
} else {
  // Tauri reads its version before beforeBuildCommand, so sync before launching it.
  const sync = spawnSync(process.execPath, [path.join(root, 'make/sync-branding.mjs')], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (sync.status !== 0) process.exit(sync.status ?? 1);
  // Keep the native desktop resources in lockstep with the canonical SVG.
  // Tauri otherwise reuses a stale ICO when packaging a Windows executable.
  const icons = spawnSync(process.execPath, [path.join(root, 'make/generate-icons.mjs')], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (icons.status !== 0) process.exit(icons.status ?? 1);
  command = process.execPath;
  commandArgs = [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...args];
}
const result = spawnSync(command, commandArgs, {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status === 0 && args[0] === 'build' && !args.includes('--no-bundle')) {
  const { collectTauri } = await import('./collect-tauri.mjs');
  await collectTauri(root, args, env);
}
process.exit(result.status ?? 1);
