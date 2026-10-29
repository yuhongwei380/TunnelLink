import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createTempDirectory } from '../lib/paths.mjs';
import path from 'node:path';
import { prepareTauri } from '../prepare-tauri.mjs';
import { projectRoot, verifyEngineRelease } from '../openvpn3-release.mjs';
import {
  driverManifest,
  verifyDriverFiles,
  verifyWindowsEngine,
  prepareWindowsDriver,
} from '../windows/prepare-driver.mjs';

import { engineFixture } from './helpers/engine-fixture.mjs';

test('Windows resources keep build tools out of the installed runtime', async (t) => {
  const directory = await createTempDirectory('openvpn-windows-resources-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configDirectory = path.join(projectRoot, 'ui/src-tauri');
  const config = JSON.parse(
    await fs.readFile(path.join(configDirectory, 'tauri.windows.conf.json'), 'utf8'),
  );
  const buildDirectory = path.join(projectRoot, 'make');
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    const input = path.resolve(configDirectory, source);
    const relative = path.relative(buildDirectory, input);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const output = path.join(directory, destination);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.cp(input, output, { recursive: true });
  }

  assert.deepEqual(await fs.readdir(path.join(directory, 'windows')), ['install-tap-driver.ps1']);
  assert.equal(
    await fs.readFile(path.join(directory, 'windows/install-tap-driver.ps1'), 'utf8'),
    await fs.readFile(path.join(buildDirectory, 'windows/install-tap-driver.ps1'), 'utf8'),
  );
});

test('Windows packaging embeds the generated application icon', async () => {
  const configDirectory = path.join(projectRoot, 'ui/src-tauri');
  const baseConfig = JSON.parse(
    await fs.readFile(path.join(configDirectory, 'tauri.conf.json'), 'utf8'),
  );
  const windowsConfig = JSON.parse(
    await fs.readFile(path.join(configDirectory, 'tauri.windows.conf.json'), 'utf8'),
  );
  assert.ok(baseConfig.bundle.icon.includes('icons/icon.ico'));
  assert.deepEqual(windowsConfig.bundle.icon, ['icons/icon.ico']);
  assert.equal(windowsConfig.bundle.windows.nsis.installerIcon, 'icons/icon.ico');
  assert.equal(windowsConfig.bundle.windows.nsis.uninstallerIcon, 'icons/icon.ico');
  await fs.access(path.join(configDirectory, 'icons/icon.ico'));
});

test('Windows uninstall clears this account data but retains shared TAP resources', async () => {
  const root = path.join(projectRoot, 'make/windows');
  const hooks = await fs.readFile(path.join(root, 'installer-hooks.nsh'), 'utf8');
  const nativeSource = await fs.readFile(path.join(projectRoot, 'ui/src-tauri/src/lib.rs'), 'utf8');
  assert.match(hooks, /\$UpdateMode <> 1/);
  assert.match(hooks, /--clear-uninstall-data/);
  assert.doesNotMatch(hooks, /delete.*tap|remove.*tap/i);
  assert.match(nativeSource, /uninstall\.exe/);
  assert.match(nativeSource, /\.args\(\["\/S", "\/FROMAPP=1"\]\)/);
});

test('packaging accepts the matching engine, including PowerShell UTF-8 BOM metadata', async (t) => {
  const fixture = await engineFixture(t);
  await verifyWindowsEngine(fixture.directory);
});

for (const [field, value] of Object.entries({
  version: '3.11.7',
  sourceRef: 'released',
  sourceCommit: '0'.repeat(40),
})) {
  test(`an engine with stale ${field} is rejected even with a matching binary hash`, async (t) => {
    const fixture = await engineFixture(t);
    fixture.metadata[field] = value;
    await fixture.save();
    await assert.rejects(verifyWindowsEngine(fixture.directory), /OpenVPN release mismatch/);
  });
}

test('the same release gate protects macOS engine bundles', async (t) => {
  const fixture = await engineFixture(t);
  const mac = path.join(fixture.directory, '.cache/native/bin/macos');
  await fs.mkdir(mac);
  await fs.copyFile(path.join(fixture.bin, 'ovpncli.exe'), path.join(mac, 'ovpncli'));
  await fs.copyFile(
    path.join(fixture.bin, 'ovpncli-build.json'),
    path.join(mac, 'ovpncli-build.json'),
  );
  await verifyEngineRelease(path.join(mac, 'ovpncli'), fixture.directory);
  await fs.writeFile(path.join(mac, 'ovpncli'), 'different Mach-O binary');
  await assert.rejects(
    verifyEngineRelease(path.join(mac, 'ovpncli'), fixture.directory),
    /does not match/,
  );
});

test('a Connect-specific engine cannot be shipped with the standalone driver', async (t) => {
  const fixture = await engineFixture(t);
  fixture.metadata.tapComponentId = 'tap_ovpnconnect';
  await fixture.save();
  await assert.rejects(verifyWindowsEngine(fixture.directory), /requires an x64 tap0901 engine/);
});

test('replacing the engine without rebuilding invalidates its metadata', async (t) => {
  const fixture = await engineFixture(t);
  await fs.writeFile(path.join(fixture.bin, 'ovpncli.exe'), 'different-engine');
  await assert.rejects(verifyWindowsEngine(fixture.directory), /does not match its build metadata/);
});

test('missing engine metadata or runtime DLLs block packaging', async (t) => {
  const fixture = await engineFixture(t);
  await fs.rm(path.join(fixture.bin, 'libssl-3-x64.dll'));
  await assert.rejects(verifyWindowsEngine(fixture.directory), /must include the OpenSSL/);
  await fs.rm(path.join(fixture.bin, 'ovpncli-build.json'));
  await assert.rejects(verifyWindowsEngine(fixture.directory), /metadata is missing or invalid/);
});

test('Windows hooks reject unsupported architectures and do not affect Linux', async () => {
  await assert.rejects(prepareTauri({ platform: 'linux' }), /supports Windows and macOS/);
  await assert.rejects(prepareTauri({ platform: 'win32', arch: 'arm64' }), /x64 installers only/);
});

test('driver manifest pins every shipped executable/driver file', () => {
  assert.equal(driverManifest.componentId, 'tap0901');
  assert.deepEqual(Object.keys(driverManifest.files).sort(), [
    'OemVista.inf',
    'devcon.exe',
    'tap0901.cat',
    'tap0901.sys',
  ]);
  for (const hash of [
    ...Object.values(driverManifest.files),
    driverManifest.archive.sha256,
    driverManifest.source.sha256,
  ]) {
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
});

test('modified driver payloads are rejected', async (t) => {
  const directory = await createTempDirectory('openvpn-driver-test-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'devcon.exe'), 'modified-driver-tool');
  await assert.rejects(verifyDriverFiles(directory), /checksum mismatch: devcon.exe/);
});

test('a damaged cached download is rejected before extraction', async (t) => {
  const fixture = await engineFixture(t);
  const cache = path.join(fixture.directory, '.cache/tap-windows6');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, driverManifest.archive.name), 'corrupt archive');
  await assert.rejects(
    prepareWindowsDriver(fixture.directory),
    /Cached driver asset checksum mismatch/,
  );
});
