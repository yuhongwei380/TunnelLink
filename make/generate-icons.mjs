import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'resources/brand/app-icon.svg');
const stagingDir = path.join(root, '.cache/branding-icons');
const iconsDir = path.join(root, 'ui/src-tauri/icons');
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');

// Stage the full Tauri output, then keep only this project's desktop formats.
const result = spawnSync(process.execPath, [cli, 'icon', source, '--output', stagingDir], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const icons = [
  '32x32.png',
  '64x64.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.png',
  'icon.ico',
  'icon.icns',
];
fs.mkdirSync(iconsDir, { recursive: true });
for (const name of icons) {
  const generated = fs.readFileSync(path.join(stagingDir, name));
  const destination = path.join(iconsDir, name);
  if (!fs.existsSync(destination) || !generated.equals(fs.readFileSync(destination))) {
    fs.writeFileSync(destination, generated);
  }
}
console.log(`Desktop icons generated from resources/brand/app-icon.svg (${icons.length} files).`);
