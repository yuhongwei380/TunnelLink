import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createTempDirectory } from '../lib/paths.mjs';
import path from 'node:path';
import { verifyDesktopStack } from '../verify-desktop-stack.mjs';

async function fixture(t) {
  const root = await createTempDirectory('tauri-stack-test-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src-tauri'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      dependencies: { '@tauri-apps/api': '^2' },
      devDependencies: { '@tauri-apps/cli': '^2' },
    }),
  );
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
  for (const name of ['tauri.conf.json', 'tauri.windows.conf.json', 'tauri.macos.conf.json'])
    await fs.writeFile(path.join(root, 'src-tauri', name), '{}');
  return root;
}

test('the desktop gate accepts a Tauri-only project', async (t) => {
  await verifyDesktopStack(await fixture(t));
});

test('transitive desktop runtime and compatibility dependencies block builds', async (t) => {
  const root = await fixture(t);
  for (const name of ['electron', '@electron/asar', 'electron-builder', 'electron-to-chromium']) {
    await fs.writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ packages: { [`node_modules/${name}`]: {} } }),
    );
    await assert.rejects(verifyDesktopStack(root), /Unexpected desktop dependencies/);
  }
});

test('old runtime directories and resource references block builds', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'electron'));
  await assert.rejects(verifyDesktopStack(root), /Obsolete desktop entry/);
  await fs.rmdir(path.join(root, 'electron'));
  await fs.writeFile(
    path.join(root, 'src-tauri/tauri.macos.conf.json'),
    JSON.stringify({ bundle: { resources: ['../electron/bin'] } }),
  );
  await assert.rejects(verifyDesktopStack(root), /Obsolete desktop resource/);
});

test('package metadata and scripts cannot reintroduce the previous desktop runtime', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const obsolete of [
    { main: 'electron/main.cjs' },
    { build: { appId: 'old-client' } },
    { config: { forge: './forge.config.js' } },
    { scripts: { package: 'electron-builder --win' } },
    { scripts: { package: 'node build/before-pack.cjs' } },
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...pkg, ...obsolete }));
    await assert.rejects(
      verifyDesktopStack(root),
      /Obsolete desktop (?:package configuration|script)/,
    );
  }
});

test('standalone configuration files from the previous packagers block builds', async (t) => {
  const root = await fixture(t);
  for (const name of ['electron-builder.yml', 'forge.config.cjs']) {
    const file = path.join(root, name);
    await fs.writeFile(file, '');
    await assert.rejects(verifyDesktopStack(root), /Obsolete desktop entry/);
    await fs.rm(file);
  }
});
