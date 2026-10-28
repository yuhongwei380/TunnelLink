import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareEngineSource, verifyEngineCache } from '../engine-cache.mjs';
import { installDependencies } from '../install-dependencies.mjs';
import { createTempDirectory, projectRoot } from '../lib/paths.mjs';
import { engineFixture } from './helpers/engine-fixture.mjs';

test('a verified engine cache rejects a different architecture, configuration, driver or missing runtime', async (t) => {
  const f = await engineFixture(t);
  f.metadata.configuration = 'Release';
  await f.save();
  const options = { root: f.directory, platform: 'windows', arch: 'x64' };
  assert.equal(await verifyEngineCache(options), path.join(f.bin, 'ovpncli.exe'));
  for (const extra of [
    { arch: 'arm64' },
    { configuration: 'Debug' },
    { tapComponentId: 'tap_ovpnconnect' },
  ]) {
    await assert.rejects(verifyEngineCache({ ...options, ...extra }), /does not match/);
  }
  await fs.unlink(path.join(f.bin, 'libssl-3-x64.dll'));
  await assert.rejects(verifyEngineCache(options), /runtime DLLs/);
});

test(
  'Windows native build returns on a binary cache hit before probing compiler dependencies',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await engineFixture(t);
    f.metadata.configuration = 'Release';
    await f.save();
    for (const file of [
      'make/windows/build-openvpn3.ps1',
      'make/windows/openssl.ps1',
      'make/engine-cache.mjs',
      'make/openvpn3-release.mjs',
    ]) {
      await fs.mkdir(path.dirname(path.join(f.directory, file)), { recursive: true });
      await fs.copyFile(path.join(projectRoot, file), path.join(f.directory, file));
    }
    const work = path.join(f.directory, 'existing work');
    await fs.mkdir(work);
    await fs.writeFile(path.join(work, 'keep.txt'), 'existing cache');
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '& $env:OPENVPN_TEST_SCRIPT -AutoInstallDeps:$false -WorkDir $env:OPENVPN_TEST_WORK',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          OPENVPN_TEST_SCRIPT: path.join(f.directory, 'make/windows/build-openvpn3.ps1'),
          OPENVPN_TEST_WORK: work,
        },
      },
    );
    assert.match(output, /Engine binary cache hit/);
    assert.doesNotMatch(output, /Checking\/installing required commands/);
    assert.equal(await fs.readFile(path.join(work, 'keep.txt'), 'utf8'), 'existing cache');
  },
);

async function temporary(t) {
  const root = await createTempDirectory('build-cache-');
  t.after(async () => {
    const relative = path.relative(path.join(projectRoot, '.cache/tmp'), await fs.realpath(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test(
  'Windows source patches preserve timestamps on cache hits and refresh changed dependency paths',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const work = await temporary(t);
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(projectRoot, 'make/tests/unified/windows-engine-cache.Tests.ps1'),
        '-WorkDirectory',
        work,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
  },
);

test('engine source can be reused offline without resetting patches or compiler output', async (t) => {
  const root = await temporary(t);
  const repository = path.join(root, 'upstream');
  await fs.mkdir(path.join(repository, 'openvpn/common'), { recursive: true });
  await fs.writeFile(
    path.join(repository, 'openvpn/common/version.hpp'),
    '#define OPENVPN_VERSION "1.2.3"\n',
  );
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-C', repository, ...args],
      { encoding: 'utf8', windowsHide: true, stdio: 'pipe' },
    ).trim();
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const release = { version: '1.2.3', commit: git('rev-parse', 'HEAD') };
  const workDir = path.join(root, 'work with spaces');
  const options = { workDir, repository, release };
  const source = await prepareEngineSource(options);
  await fs.writeFile(path.join(source, 'local-patch.txt'), 'preserved');
  await fs.mkdir(path.join(workDir, 'build'));
  await fs.writeFile(path.join(workDir, 'build/object'), 'cached');
  await fs.rename(repository, repository + '-offline');
  assert.equal(await prepareEngineSource(options), source);
  assert.equal(await fs.readFile(path.join(source, 'local-patch.txt'), 'utf8'), 'preserved');
  assert.equal(await fs.readFile(path.join(workDir, 'build/object'), 'utf8'), 'cached');
  await assert.rejects(
    prepareEngineSource({ ...options, repository: repository + '-different' }),
    /origin differs/,
  );
  await assert.rejects(
    prepareEngineSource({ ...options, release: { ...release, commit: '0'.repeat(40) } }),
    /commit differs/,
  );
});

test('Node dependencies skip installation on a cache hit and reinstall for changed locks or missing packages', async (t) => {
  const root = await temporary(t);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { example: '1.0.0' } }),
  );
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
  let installs = 0;
  const install = async () => {
    installs++;
    await fs.mkdir(path.join(root, 'node_modules/example'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules/example/package.json'), '{}');
    await fs.writeFile(path.join(root, 'node_modules/.package-lock.json'), '{}');
  };
  assert.equal(await installDependencies(root, install), true);
  assert.equal(await installDependencies(root, install), false);
  assert.equal(installs, 1);
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"changed":true}');
  assert.equal(await installDependencies(root, install), true);
  await fs.unlink(path.join(root, 'node_modules/example/package.json'));
  assert.equal(await installDependencies(root, install), true);
  assert.equal(installs, 3);
});
