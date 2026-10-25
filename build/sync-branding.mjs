import fs from 'node:fs';
import path from 'node:path';
import { readRelease } from './openvpn3-release.mjs';

const rootDir = process.cwd();
const pkgPath = path.join(rootDir, 'package.json');
const brandingPath = path.join(rootDir, 'config', 'app-branding.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== content)
    fs.writeFileSync(filePath, content, 'utf8');
}

if (!fs.existsSync(brandingPath)) {
  throw new Error(`Branding file not found: ${brandingPath}`);
}

const branding = readJson(brandingPath);
const appId = String(branding.appId || '').trim();
const productName = String(branding.productName || '').trim();
const packageName = productName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 214);

if (!appId) {
  throw new Error('config/app-branding.json missing field: appId');
}
if (!productName) {
  throw new Error('config/app-branding.json missing field: productName');
}

const pkg = readJson(pkgPath);
const release = await readRelease(rootDir);
await import('./prepare-agreement.mjs');
pkg.version = release.version;
if (packageName) {
  pkg.name = packageName;
}
const tauriPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauri = readJson(tauriPath);
tauri.identifier = appId;
tauri.productName = productName;
tauri.version = pkg.version;
tauri.app.windows[0].title = productName;
writeJson(tauriPath, tauri);
const cargoPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const cargo = fs
  .readFileSync(cargoPath, 'utf8')
  .replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${pkg.version}"`);
if (fs.readFileSync(cargoPath, 'utf8') !== cargo) fs.writeFileSync(cargoPath, cargo, 'utf8');

writeJson(pkgPath, pkg);
const lockPath = path.join(rootDir, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  lock.name = pkg.name;
  lock.version = pkg.version;
  if (lock.packages?.['']) {
    lock.packages[''].name = pkg.name;
    lock.packages[''].version = pkg.version;
  }
  writeJson(lockPath, lock);
}
console.log(`Branding synced: appId=${appId}, productName=${productName}`);
