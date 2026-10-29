import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFeatures, validateFeatures } from '../../lib/client-features.mjs';
import { runBuild } from '../../build.mjs';
import { parseOptions } from '../../lib/build.mjs';

test('feature combinations, labels and command-line overrides are validated', async (t) => {
  const root = await fs.mkdtemp(path.resolve('.cache/tmp/features-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'custom-config'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'custom-config/client-features.json'),
    JSON.stringify({
      _comment: 'fixture options',
      builtinProfile: { _comment: 'built-in', enabled: true, displayName: 'Demo Lab' },
      profileImport: { _comment: 'imports', enabled: false },
    }),
  );
  assert.equal((await readFeatures(root, {})).builtinProfile.displayName, 'Demo Lab');
  const f = await readFeatures(
    root,
    parseOptions(['--builtin-profile=disabled', '--profile-import=enabled']),
  );
  assert.equal(f.builtinProfile.enabled, false);
  assert.equal(f.profileImport.enabled, true);
  assert.throws(
    () =>
      validateFeatures({ builtinProfile: { enabled: false }, profileImport: { enabled: false } }),
    /At least one/,
  );
  assert.throws(() => parseOptions(['--profile-import=perhaps']), /enabled or disabled/);
  assert.equal(
    validateFeatures({
      builtinProfile: { enabled: true, displayName: '  ' },
      profileImport: { enabled: true },
    }).builtinProfile.displayName,
    'Internal Tunnel',
  );
  await fs.writeFile(
    path.join(root, 'custom-config/client-features.json'),
    '{"builtinProfile":true}',
  );
  await assert.rejects(readFeatures(root, {}), /Invalid/);
});

test('pure import builds do not need private profiles and erase staged built-in bytes', async (t) => {
  const root = await fs.mkdtemp(path.resolve('.cache/tmp/features-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'resources/settings'), { recursive: true });
  await fs.writeFile(path.join(root, 'resources/settings/client.ovpn'), 'PRIVATE-BUILTIN-MARKER');
  const options = { root, localSource: true };
  await runBuild(['--platform=windows', '--prepare-only', '--builtin-profile=disabled'], options);
  const source = path.join(root, '.cache/work/windows/source/resources/settings');
  assert.equal(await fs.readFile(path.join(source, 'client.ovpn'), 'utf8'), '');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(source, 'client-features.json'), 'utf8')).builtinProfile
      .enabled,
    false,
  );
  assert.equal(
    await fs.readFile(path.join(root, 'resources/settings/client.ovpn'), 'utf8'),
    'PRIVATE-BUILTIN-MARKER',
  );
  await assert.rejects(
    runBuild(
      ['--prepare-only', '--builtin-profile=disabled', '--profile=unexpected.ovpn'],
      options,
    ),
    /conflicts/,
  );
  await assert.rejects(
    runBuild(
      ['--prepare-only', '--builtin-profile=disabled', '--profile-import=disabled'],
      options,
    ),
    /At least one/,
  );
});
