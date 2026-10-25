import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareTauri } from '../../prepare-tauri.mjs';
import { projectRoot as root } from '../../openvpn3-release.mjs';
import { driverManifest, verifyDriverFiles } from '../../windows/prepare-driver.mjs';
import { engineFixture } from '../helpers/engine-fixture.mjs';

// Requires npm run prepare:driver:win. These tests validate real downloaded payloads.
test('the actual prepared driver payload matches the pinned official hashes', async () => {
  // Run npm run prepare:driver:win first. No drivers are installed by this test.
  await verifyDriverFiles(path.join(root, 'native/drivers/windows-x64/tap-windows6'));
});

test('the Windows packaging hook stages the offline driver, installer payload, and licenses', async (t) => {
  const fixture = await engineFixture(t);
  await fs.cp(
    path.join(root, 'LICENSES/tap-windows6'),
    path.join(fixture.directory, 'LICENSES/tap-windows6'),
    { recursive: true },
  );
  const cache = path.join(fixture.directory, '.cache/tap-windows6');
  await fs.mkdir(cache, { recursive: true });
  for (const asset of [driverManifest.archive]) {
    await fs.copyFile(
      path.join(root, '.cache/tap-windows6', asset.name),
      path.join(cache, asset.name),
    );
  }
  await prepareTauri({ platform: 'win32', arch: 'x64', root: fixture.directory });
  const output = path.join(fixture.directory, 'native/drivers/windows-x64/tap-windows6');
  await verifyDriverFiles(output);
  await assert.rejects(fs.access(path.join(output, driverManifest.source.name)), {
    code: 'ENOENT',
  });
  assert.match(
    await fs.readFile(path.join(output, 'COPYRIGHT.GPL'), 'utf8'),
    /END OF TERMS AND CONDITIONS/,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8')).componentId,
    'tap0901',
  );
});
