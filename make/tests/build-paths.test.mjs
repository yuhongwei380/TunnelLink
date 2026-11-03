import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildEnvironment, createTempDirectory, projectRoot } from '../lib/paths.mjs';
import { packageInvocation, prepareLocalSource, prepareSource } from '../lib/build.mjs';
import { runBuild } from '../build.mjs';

async function fixture(t) {
  const root = await createTempDirectory('build-paths-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('standalone builds keep their compiler and download caches in the project cache', async (t) => {
  const root = await fixture(t);
  const env = buildEnvironment(root, {});
  assert.equal(env.CARGO_TARGET_DIR, path.join(root, '.cache/cargo-target'));
  assert.equal(env.npm_config_cache, path.join(root, '.cache/npm'));
  assert.equal(env.TMP, path.join(root, '.cache/tmp'));
});

for (const platform of ['windows', 'macos']) {
  test(`${platform} unified build caches stay beside source across child processes`, async (t) => {
    const root = await fixture(t);
    const work = path.join(root, '.cache/work', platform);
    const sourceDir = path.join(work, 'source');
    const invocation = packageInvocation({ sourceDir, platform }, {}, {});
    assert.equal(invocation.env.OPENVPN_BUILD_WORK_ROOT, work);
    assert.equal(buildEnvironment(sourceDir, {}).OPENVPN_BUILD_WORK_ROOT, work);
    let env = buildEnvironment(sourceDir, invocation.env);
    for (const childRoot of [sourceDir, path.join(sourceDir, 'ui'), sourceDir]) {
      env = buildEnvironment(childRoot, env);
      for (const [key, directory] of [
        ['CARGO_TARGET_DIR', 'cargo-target'],
        ['npm_config_cache', 'npm'],
        ['SWC_NATIVE_BINDING_CACHE', 'swc'],
        ['TMP', 'tmp'],
        ['TEMP', 'tmp'],
        ['TMPDIR', 'tmp'],
      ]) {
        assert.equal(env[key], path.join(work, directory));
        assert.ok(path.relative(sourceDir, env[key]).startsWith('..'));
      }
    }
    assert.equal(env.OPENVPN_BUILD_OUTPUT, path.join(sourceDir, '.cache/packaging'));
  });

  test(`${platform} cached source cannot start another unified build`, async (t) => {
    const root = await fixture(t);
    const source = path.join(root, '.cache/work', platform, 'source');
    const options = { root: source, platform };
    await assert.rejects(
      runBuild(['--prepare-only', '--platform', platform], { root: source }),
      /original repository/,
    );
    await assert.rejects(prepareLocalSource(options), /original repository/);
    await assert.rejects(prepareSource(options), /original repository/);
    await assert.rejects(fs.access(source), { code: 'ENOENT' });
  });
}

test(
  'Windows engine and OpenSSL use the shared work root, compact variant keys and explicit overrides',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t);
    const work = path.join(root, 'work with spaces');
    const sourceDir = path.join(root, '.cache/work/windows/source');
    const scripts = path.join(sourceDir, 'make/windows');
    await fs.mkdir(scripts, { recursive: true });
    await fs.mkdir(path.join(sourceDir, 'resources/settings'), { recursive: true });
    for (const file of ['make/windows/openssl.ps1', 'resources/settings/openvpn3-release.json']) {
      await fs.copyFile(path.join(projectRoot, file), path.join(sourceDir, file));
    }
    const script = await fs.readFile(
      path.join(projectRoot, 'make/windows/build-openvpn3.ps1'),
      'utf8',
    );
    const end = script.indexOf('\nif (-not $Force) {');
    assert.ok(end > 0);
    const probe = path.join(scripts, 'path-probe.ps1');
    await fs.writeFile(
      probe,
      script.slice(0, end) +
        '\n@{ work = $WorkDir; source = $SrcDir; build = $BuildDir; ssl = Get-OpenSslCacheDirectory ([pscustomobject]@{ version = "3.5.0" }) } | ConvertTo-Json -Compress\n',
    );
    const env = { ...process.env, OPENVPN_BUILD_WORK_ROOT: work };
    const inspect = (args = [], environment = env) =>
      JSON.parse(
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe, ...args],
          {
            encoding: 'utf8',
            windowsHide: true,
            env: environment,
          },
        ),
      );
    const actual = inspect();
    assert.equal(path.dirname(actual.work), work);
    assert.match(path.basename(actual.work), /^openvpn3-[a-f0-9]{12}-[a-f0-9]{12}$/);
    assert.equal(actual.source, path.join(actual.work, 'openvpn3'));
    assert.equal(actual.build, path.join(actual.work, 'build'));
    assert.equal(actual.ssl, path.join(work, 'deps/openssl-3.5.0'));
    assert.deepEqual(inspect(), actual);
    for (const args of [
      ['-Generator', 'Ninja'],
      ['-Platform', 'arm64'],
      ['-Configuration', 'Debug'],
      ['-TapComponentId', 'tap_ovpnconnect'],
    ]) {
      assert.notEqual(inspect(args).work, actual.work);
    }
    const explicit = path.join(root, 'explicit work');
    assert.equal(inspect(['-WorkDir', explicit]).work, explicit);
    assert.equal(path.dirname(inspect(['-WorkRoot', explicit]).work), explicit);
    const standaloneEnv = { ...process.env };
    delete standaloneEnv.OPENVPN_BUILD_WORK_ROOT;
    const standalone = inspect([], standaloneEnv);
    assert.equal(path.dirname(standalone.work), path.dirname(sourceDir));
    assert.equal(standalone.ssl, path.join(path.dirname(sourceDir), 'deps/openssl-3.5.0'));
  },
);

test('macOS engine honors the shared work root and explicit work directory', async (t) => {
  const bash =
    process.platform === 'win32'
      ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe')
      : '/bin/bash';
  try {
    await fs.access(bash);
  } catch {
    t.skip('Bash is unavailable.');
    return;
  }
  const root = await fixture(t);
  const sourceDir = path.join(root, '.cache/work/macos/source');
  const scripts = path.join(sourceDir, 'make/macos');
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(path.join(sourceDir, 'resources/settings'), { recursive: true });
  await fs.copyFile(
    path.join(projectRoot, 'resources/settings/openvpn3-release.json'),
    path.join(sourceDir, 'resources/settings/openvpn3-release.json'),
  );
  const script = await fs.readFile(path.join(projectRoot, 'make/macos/build-openvpn3.sh'), 'utf8');
  const end = script.indexOf('\narray_contains()');
  assert.ok(end > 0);
  const probe = path.join(scripts, 'path-probe.sh');
  await fs.writeFile(
    probe,
    script.slice(0, end).replaceAll('\r\n', '\n') + '\nprintf "%s\\n" "$WORKDIR"\n',
  );
  const work = path.join(root, 'shared work').replaceAll('\\', '/');
  const env = { ...process.env, OPENVPN_BUILD_WORK_ROOT: work };
  delete env.OPENVPN3_WORKDIR;
  const inspect = (environment) =>
    execFileSync(bash, [probe.replaceAll('\\', '/')], {
      encoding: 'utf8',
      windowsHide: true,
      env: environment,
    }).trim();
  const actual = inspect(env);
  assert.ok(actual.startsWith(work + '/openvpn3-'));
  assert.match(actual.slice(work.length), /^\/openvpn3-[a-f0-9]{12}-[^/]+-11\.0$/);
  const explicit = work + '/explicit';
  assert.equal(inspect({ ...env, OPENVPN3_WORKDIR: explicit }), explicit);
  const standaloneEnv = { ...env };
  delete standaloneEnv.OPENVPN_BUILD_WORK_ROOT;
  const standalone = inspect(standaloneEnv);
  assert.match(standalone, /\/\.cache\/work\/macos\/openvpn3-/);
  assert.doesNotMatch(standalone, /\/source\//);
});
