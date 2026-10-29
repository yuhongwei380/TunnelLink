import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  assertBuildHost,
  buildPackage,
  collectArtifacts,
  detectPlatform,
  loadUpstream,
  packageInvocation,
  parseOptions,
  prepareLocalSource,
  prepareSource,
  readProfile,
  withBuildLock,
} from '../../lib/build.mjs';
import { runBuild } from '../../build.mjs';
import { setupEnvironment } from '../../lib/setup.mjs';
import { prepareTauriLayout } from '../../lib/paths.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = path.join(projectRoot, '.cache/work/tests');
const hash = (content) => createHash('sha256').update(content).digest('hex');
const git = (root, ...args) =>
  execFileSync(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-C', root, ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  ).trim();

async function fixture(t) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtureRoot, 'build-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    const relative = path.relative(await fs.realpath(fixtureRoot), resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Unsafe fixture cleanup path.');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5 });
  });
  const upstreamRepo = path.join(directory, 'upstream repo');
  const root = path.join(directory, 'private build');
  await fs.mkdir(path.join(upstreamRepo, 'resources/settings'), { recursive: true });
  await fs.mkdir(path.join(upstreamRepo, 'make/windows'), { recursive: true });
  await fs.mkdir(path.join(upstreamRepo, 'make/macos'), { recursive: true });
  await fs.mkdir(path.join(root, 'resources/settings'), { recursive: true });
  await fs.writeFile(
    path.join(upstreamRepo, '.gitattributes'),
    '* text=auto\n*.sh text eol=lf\n*.ps1 text eol=crlf\n',
  );
  await fs.writeFile(path.join(upstreamRepo, '.gitignore'), '/.cache/packaging/\n');
  await fs.writeFile(
    path.join(upstreamRepo, 'resources/settings/client.ovpn'),
    'client\nremote upstream.example.invalid 1194\n',
  );
  await fs.writeFile(path.join(upstreamRepo, 'package-lock.json'), '{}\n');
  await fs.writeFile(
    path.join(upstreamRepo, 'make/windows/package.ps1'),
    "& node (Join-Path $PSScriptRoot '../../fake-package.mjs')\nexit $LASTEXITCODE\n",
  );
  await fs.writeFile(
    path.join(upstreamRepo, 'make/macos/package.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\nnode fake-package.mjs\n',
  );
  await fs.writeFile(
    path.join(upstreamRepo, 'fake-package.mjs'),
    `
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
await fs.mkdir('.cache/packaging', { recursive: true });
const file = path.resolve('.cache/packaging', process.platform === 'win32' ? 'Private Client-Setup.exe' : 'Private Client.dmg');
const content = await fs.readFile('resources/settings/client.ovpn');
await fs.writeFile(file, content);
await fs.writeFile('.cache/packaging/build-verification.json', JSON.stringify({ artifacts: [
  { file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }
] }));
`,
  );
  git(upstreamRepo, 'init', '--quiet', '-b', 'main');
  git(upstreamRepo, 'add', '.');
  git(
    upstreamRepo,
    '-c',
    'user.name=Build Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Fixture source',
  );
  const commit = git(upstreamRepo, 'rev-parse', 'HEAD');
  await fs.writeFile(
    path.join(root, 'resources/settings/upstream.json'),
    JSON.stringify({ repository: upstreamRepo, commit }),
  );
  const profileFile = path.join(directory, 'private profile $company.ovpn');
  const contents = Buffer.from(
    'client\r\nremote private.example.invalid 1194\r\nauth-user-pass\r\n<ca>\r\nTEST CERTIFICATE\r\n</ca>\r\n',
  );
  await fs.writeFile(profileFile, contents);
  return {
    root,
    upstreamRepo,
    upstream: await loadUpstream(root),
    profileFile,
    profile: await readProfile(profileFile),
  };
}

test('command-line arguments reject contradictions and repeated platforms', () => {
  assert.equal(parseOptions(['--platform', 'windows', '--prepare-only']).prepareOnly, true);
  assert.equal(
    parseOptions(['--platform=macos', '--profile', 'a path/file.ovpn']).profile,
    'a path/file.ovpn',
  );
  assert.throws(() => parseOptions(['--force-engine', '--skip-engine']), /cannot be combined/);
  assert.throws(() => parseOptions(['--platform', 'linux']), /must be windows/);
  assert.throws(() => parseOptions(['--platform', 'windows', '--platform=macos']), /only once/);
  assert.throws(() => parseOptions(['--unknown']), /Unknown option/);
});

test('native packaging rejects unsupported hosts and architectures', () => {
  assert.doesNotThrow(() => assertBuildHost('windows', 'win32', 'x64'));
  assert.doesNotThrow(() => assertBuildHost('macos', 'darwin', 'arm64'));
  assert.throws(() => assertBuildHost('windows', 'darwin', 'x64'), /must be built on/);
  assert.throws(() => assertBuildHost('macos', 'win32', 'x64'), /must be built on/);
  assert.throws(() => assertBuildHost('windows', 'win32', 'arm64'), /x64/);
});

test('OS selection is automatic and unsupported hosts fail without prompting', () => {
  assert.equal(detectPlatform(undefined, 'win32'), 'windows');
  assert.equal(detectPlatform(undefined, 'darwin'), 'macos');
  assert.equal(detectPlatform('auto', 'darwin'), 'macos');
  assert.equal(detectPlatform('macos', 'win32'), 'macos');
  assert.throws(() => detectPlatform(undefined, 'linux'), /Unsupported OS/);
});

test('Windows dependency setup resolves the shared OpenSSL helper', async () => {
  const setupScript = await fs.readFile(path.join(projectRoot, 'make/windows/setup.ps1'), 'utf8');
  assert.match(setupScript, /\.\/openssl\.ps1/);
  await fs.access(path.join(projectRoot, 'make/windows/openssl.ps1'));
});

test('upstream revisions must be complete pinned commits', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.root, 'resources/settings/upstream.json'),
    JSON.stringify({ repository: f.upstreamRepo, commit: 'main' }),
  );
  await assert.rejects(loadUpstream(f.root), /40-character commit/);
});

test('profiles preserve exact bytes and reject missing, empty, binary or externally referenced inputs', async (t) => {
  const f = await fixture(t);
  assert.equal(f.profile.sha256, hash(f.profile.contents));
  await assert.rejects(readProfile(path.join(f.root, 'missing.ovpn')), /Private profile not found/);
  for (const content of ['', ' \r\n ', 'client\0secret']) {
    await fs.writeFile(f.profileFile, content);
    await assert.rejects(readProfile(f.profileFile), /non-empty text file/);
  }
  for (const line of [
    'ca "secret ca.crt"',
    'key ../secret.key',
    'auth-user-pass passwords.txt',
    'config private.conf',
    '--tls-crypt key.pem',
  ]) {
    await fs.writeFile(f.profileFile, `client\n${line}\n`);
    await assert.rejects(
      readProfile(f.profileFile),
      (error) => /external file/.test(error.message) && !error.message.includes('secret'),
    );
  }
  await fs.writeFile(
    f.profileFile,
    '# ca ignored.crt\nauth-user-pass # prompt\nca [inline]\n<ca>\nkey certificate-data\n</ca>\n',
  );
  await assert.doesNotReject(readProfile(f.profileFile));
});

test('source fetches the pinned commit and replaces only the managed profile', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSource({ ...f, platform: 'windows' });
  assert.equal(git(prepared.sourceDir, 'rev-parse', 'HEAD'), f.upstream.commit);
  assert.deepEqual(
    await fs.readFile(path.join(prepared.sourceDir, 'resources/settings/client.ovpn')),
    f.profile.contents,
  );
  assert.equal(prepared.profileSha256, f.profile.sha256);
  assert.equal(git(f.upstreamRepo, 'status', '--porcelain'), '');
  assert.equal(git(prepared.sourceDir, 'diff', '--name-only'), 'resources/settings/client.ovpn');
});

test('the merged installer snapshots the current working tree without copying private inputs', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'resources/settings/client.ovpn'), 'client\n');
  await fs.mkdir(path.join(f.root, 'custom-config'));
  await fs.copyFile(f.profileFile, path.join(f.root, 'custom-config/client.ovpn'));
  await fs.mkdir(path.join(f.root, 'private'));
  await fs.copyFile(f.profileFile, path.join(f.root, 'private/client.ovpn'));
  await fs.mkdir(path.join(f.root, 'ui/src-tauri'), { recursive: true });
  prepareTauriLayout(f.root);
  await fs.writeFile(path.join(f.root, '.cache/tauri/gen/cached-schema.json'), '{}');
  await fs.mkdir(path.join(f.root, '.cache/native/bin'), { recursive: true });
  await fs.writeFile(path.join(f.root, '.cache/native/bin/engine'), 'prepared engine');
  await fs.mkdir(path.join(f.root, 'build_dist'));
  await fs.writeFile(path.join(f.root, 'build_dist/old-installer.exe'), 'old package');
  const prepared = await prepareLocalSource({
    root: f.root,
    platform: 'windows',
    upstream: { repository: 'local-working-tree', commit: 'working-tree' },
    profile: f.profile,
  });
  assert.notEqual(prepared.sourceDir, f.root);
  assert.deepEqual(
    await fs.readFile(path.join(prepared.sourceDir, 'resources/settings/client.ovpn')),
    f.profile.contents,
  );
  await assert.rejects(fs.stat(path.join(prepared.sourceDir, 'private')));
  await assert.rejects(fs.stat(path.join(prepared.sourceDir, 'custom-config')));
  await assert.rejects(fs.stat(path.join(prepared.sourceDir, 'build_dist')));
  await assert.rejects(fs.lstat(path.join(prepared.sourceDir, 'ui/src-tauri/gen')));
  assert.deepEqual(await fs.readdir(path.join(prepared.sourceDir, '.cache')), ['native']);
  assert.equal(
    await fs.readFile(path.join(prepared.sourceDir, '.cache/native/bin/engine'), 'utf8'),
    'prepared engine',
  );
});

test('local preparation uses validated VPN branding and falls back to the source default', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'resources/settings/client.ovpn'), 'client\n');
  const defaultBranding = { appId: 'example.client', productName: 'Client', defaultLocale: 'CN' };
  const customBranding = { ...defaultBranding, defaultLocale: 'EN' };
  await fs.writeFile(
    path.join(f.root, 'resources/settings/app-branding.json'),
    JSON.stringify(defaultBranding),
  );
  await fs.mkdir(path.join(f.root, 'custom-config'));
  await fs.copyFile(f.profileFile, path.join(f.root, 'custom-config/client.ovpn'));
  const customPath = path.join(f.root, 'custom-config/app-branding.json');
  await fs.writeFile(customPath, JSON.stringify(customBranding));
  const options = { root: f.root, localSource: true };
  const target = path.join(
    f.root,
    '.cache/work/windows/source/resources/settings/app-branding.json',
  );
  await runBuild(['--platform', 'windows', '--prepare-only'], options);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), customBranding);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(f.root, 'resources/settings/app-branding.json'), 'utf8'),
    ),
    defaultBranding,
  );
  await fs.writeFile(customPath, '{invalid');
  await assert.rejects(
    runBuild(['--platform', 'windows', '--prepare-only'], options),
    /Invalid JSON/,
  );
  await fs.writeFile(customPath, JSON.stringify({ ...customBranding, defaultLocale: 'FR' }));
  await assert.rejects(runBuild(['--platform', 'windows', '--prepare-only'], options), /CN or EN/);
  await fs.unlink(customPath);
  await runBuild(['--platform', 'windows', '--prepare-only'], options);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), defaultBranding);
});

test('local snapshots preserve compiler and dependency caches while updating and removing source files', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'ui/src-tauri'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'resources/settings/client.ovpn'), 'client\n');
  await fs.writeFile(path.join(f.root, 'source.txt'), 'first');
  await fs.writeFile(path.join(f.root, 'obsolete.txt'), 'remove me');
  const options = {
    ...f,
    platform: 'windows',
    branding: Buffer.from('{"productName":"Private"}\n'),
  };
  const { sourceDir } = await prepareLocalSource(options);
  for (const file of [
    '.cache/cargo-target/incremental/object',
    '.cache/work/windows/engine/build/object',
    'node_modules/cached-module/package.json',
    '.cache/native/bin/engine',
  ]) {
    await fs.mkdir(path.dirname(path.join(sourceDir, file)), { recursive: true });
    await fs.writeFile(path.join(sourceDir, file), file);
  }
  prepareTauriLayout(sourceDir);
  const profile = path.join(sourceDir, 'resources/settings/client.ovpn');
  const branding = path.join(sourceDir, 'resources/settings/app-branding.json');
  // Use a fixed older time so this assertion does not depend on clock resolution.
  await fs.utimes(profile, 1000, 1000);
  await fs.utimes(branding, 1000, 1000);
  await fs.writeFile(path.join(f.root, 'source.txt'), 'second');
  await fs.unlink(path.join(f.root, 'obsolete.txt'));
  await prepareLocalSource(options);
  assert.equal(await fs.readFile(path.join(sourceDir, 'source.txt'), 'utf8'), 'second');
  await assert.rejects(fs.access(path.join(sourceDir, 'obsolete.txt')), { code: 'ENOENT' });
  for (const file of [
    '.cache/cargo-target/incremental/object',
    '.cache/work/windows/engine/build/object',
    'node_modules/cached-module/package.json',
    '.cache/native/bin/engine',
  ]) {
    assert.equal(await fs.readFile(path.join(sourceDir, file), 'utf8'), file);
  }
  assert.equal((await fs.stat(profile)).mtimeMs, 1000000);
  assert.equal((await fs.stat(branding)).mtimeMs, 1000000);
  assert.equal(
    await fs.realpath(path.join(sourceDir, 'ui/src-tauri/gen')),
    path.join(sourceDir, '.cache/tauri/gen'),
  );
  await prepareLocalSource({
    ...options,
    profile: { contents: Buffer.from('client\nremote changed.invalid\n'), sha256: 'changed' },
  });
  assert.equal(await fs.readFile(profile, 'utf8'), 'client\nremote changed.invalid\n');
});

test('legacy address aliases are rejected and null preserves real addresses', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'resources/settings/client.ovpn'), 'client\n');
  const defaultPath = path.join(f.root, 'resources/settings/log-privacy.json');
  await fs.writeFile(defaultPath, '{"endpointAlias":null}');
  await fs.mkdir(path.join(f.root, 'custom-config'));
  await fs.copyFile(f.profileFile, path.join(f.root, 'custom-config/client.ovpn'));
  const customPath = path.join(f.root, 'custom-config/log-privacy.json');
  await fs.writeFile(customPath, '{"endpointAlias":"demo.vpn"}');
  const options = { root: f.root, localSource: true };
  const target = path.join(
    f.root,
    '.cache/work/windows/source/resources/settings/log-privacy.json',
  );
  await assert.rejects(
    runBuild(['--platform', 'windows', '--prepare-only'], options),
    /Remove endpointAlias/,
  );
  await fs.writeFile(customPath, '{"endpointAlias":null}');
  await runBuild(['--platform', 'windows', '--prepare-only'], options);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { endpointAlias: null });
  assert.deepEqual(JSON.parse(await fs.readFile(defaultPath, 'utf8')), { endpointAlias: null });
  await fs.writeFile(customPath, '{"endpointAlias":true}');
  await assert.rejects(
    runBuild(['--platform', 'windows', '--prepare-only'], options),
    /endpointAlias/,
  );
  await fs.unlink(customPath);
  await runBuild(['--platform', 'windows', '--prepare-only'], options);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { endpointAlias: null });
});

test('repeat preparation uses cached source without a reachable remote or needless rewrites', async (t) => {
  const f = await fixture(t);
  const options = { ...f, platform: 'windows' };
  const prepared = await prepareSource(options);
  const target = path.join(prepared.sourceDir, 'resources/settings/client.ovpn');
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(target, fixedTime, fixedTime);
  const unreachable = path.join(f.root, 'nonexistent remote');
  git(prepared.sourceDir, 'remote', 'set-url', 'origin', unreachable);
  await prepareSource({ ...options, upstream: { ...f.upstream, repository: unreachable } });
  assert.equal((await fs.stat(target)).mtimeMs, fixedTime.getTime());
});

test('switching profiles replaces previous contents and uses separate platform caches', async (t) => {
  const f = await fixture(t);
  const original = await prepareSource({ ...f, platform: 'windows' });
  await fs.writeFile(f.profileFile, 'client\nremote second.example.invalid 443\n');
  const profile = await readProfile(f.profileFile);
  const changed = await prepareSource({ ...f, profile, platform: 'windows' });
  const mac = await prepareSource({ ...f, platform: 'macos' });
  assert.equal(original.sourceDir, changed.sourceDir);
  assert.notEqual(mac.sourceDir, changed.sourceDir);
  assert.deepEqual(
    await fs.readFile(path.join(changed.sourceDir, 'resources/settings/client.ovpn')),
    profile.contents,
  );
  assert.deepEqual(
    await fs.readFile(path.join(mac.sourceDir, 'resources/settings/client.ovpn')),
    f.profile.contents,
  );
});

test('upstream generators changing CRLF to LF do not block cache reuse', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSource({ ...f, platform: 'windows' });
  git(prepared.sourceDir, 'config', 'core.autocrlf', 'true');
  git(
    prepared.sourceDir,
    '-c',
    'core.autocrlf=true',
    'restore',
    '--source=HEAD',
    '--worktree',
    '--',
    'package-lock.json',
  );
  const file = path.join(prepared.sourceDir, 'package-lock.json');
  assert.equal(await fs.readFile(file, 'utf8'), '{}\r\n');
  await fs.writeFile(file, '{}\n');
  await assert.doesNotReject(prepareSource({ ...f, platform: 'windows' }));
  assert.deepEqual(
    await fs.readFile(path.join(prepared.sourceDir, 'resources/settings/client.ovpn')),
    f.profile.contents,
  );
});

test('source pin upgrades preserve the supplied private profile', async (t) => {
  const f = await fixture(t);
  const old = await prepareSource({ ...f, platform: 'windows' });
  await fs.writeFile(
    path.join(f.upstreamRepo, 'resources/settings/client.ovpn'),
    'client\nremote new-upstream.example.invalid\n',
  );
  git(f.upstreamRepo, 'add', '.');
  git(
    f.upstreamRepo,
    '-c',
    'user.name=Build Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Updated source',
  );
  const upstream = { ...f.upstream, commit: git(f.upstreamRepo, 'rev-parse', 'HEAD') };
  const updated = await prepareSource({ ...f, upstream, platform: 'windows' });
  assert.equal(old.sourceDir, updated.sourceDir);
  assert.equal(git(updated.sourceDir, 'rev-parse', 'HEAD'), upstream.commit);
  assert.deepEqual(
    await fs.readFile(path.join(updated.sourceDir, 'resources/settings/client.ovpn')),
    f.profile.contents,
  );
});

test('unexpected local source changes are preserved and stop preparation', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSource({ ...f, platform: 'windows' });
  const file = path.join(prepared.sourceDir, 'package-lock.json');
  await fs.writeFile(file, 'local edits\n');
  await assert.rejects(prepareSource({ ...f, platform: 'windows' }), /local changes/);
  assert.equal(await fs.readFile(file, 'utf8'), 'local edits\n');
  git(prepared.sourceDir, 'restore', '--', 'package-lock.json');
  await fs.writeFile(path.join(prepared.sourceDir, 'untracked.txt'), 'keep me');
  await assert.rejects(prepareSource({ ...f, platform: 'windows' }), /local changes/);
});

test('wrong remotes and non-repository cache directories are not overwritten', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSource({ ...f, platform: 'windows' });
  git(prepared.sourceDir, 'remote', 'set-url', 'origin', path.join(f.root, 'wrong'));
  await assert.rejects(prepareSource({ ...f, platform: 'windows' }), /origin does not match/);
  await fs.mkdir(path.join(f.root, '.cache/work/macos/source'), { recursive: true });
  await fs.writeFile(path.join(f.root, '.cache/work/macos/source/keep.txt'), 'do not erase');
  await assert.rejects(prepareSource({ ...f, platform: 'macos' }), /dedicated Git checkout/);
  assert.equal(
    await fs.readFile(path.join(f.root, '.cache/work/macos/source/keep.txt'), 'utf8'),
    'do not erase',
  );
});

test('concurrent builds are excluded and errors release the lock', async (t) => {
  const f = await fixture(t);
  await withBuildLock(f.root, 'windows', async () => {
    await assert.rejects(
      withBuildLock(f.root, 'windows', async () => {}),
      /already locked/,
    );
    await assert.doesNotReject(withBuildLock(f.root, 'macos', async () => {}));
  });
  await assert.rejects(
    withBuildLock(f.root, 'windows', async () => {
      throw new Error('fixture failure');
    }),
    /fixture failure/,
  );
  await assert.doesNotReject(withBuildLock(f.root, 'windows', async () => {}));
});

test('platform options are forwarded without shell interpolation', () => {
  const sourceDir = path.join(projectRoot, '.cache/work/source with $spaces');
  const windows = packageInvocation(
    { sourceDir, platform: 'windows' },
    { forceEngine: true, noAutoInstallDeps: true },
    {},
  );
  assert.equal(windows.command, 'powershell.exe');
  assert.ok(windows.args.includes(path.join(sourceDir, 'make/windows/package.ps1')));
  assert.deepEqual(windows.args.slice(-2), ['-ForceOpenVpnBuild', '-NoAutoInstallDeps']);
  const mac = packageInvocation(
    { sourceDir, platform: 'macos' },
    { skipEngine: true },
    { APPLE_SIGNING_IDENTITY: 'test identity', FORCE_OPENVPN3_BUILD: '1' },
  );
  assert.equal(mac.command, 'bash');
  assert.deepEqual(mac.args, [path.join(sourceDir, 'make/macos/package.sh')]);
  assert.equal(mac.env.FORCE_OPENVPN3_BUILD, '0');
  assert.equal(mac.env.SKIP_OPENVPN3_BUILD, '1');
  assert.equal(mac.env.APPLE_SIGNING_IDENTITY, 'test identity');
});

async function artifactFixture(t) {
  const f = await fixture(t);
  const prepared = await prepareSource({ ...f, platform: 'windows' });
  const dist = path.join(prepared.sourceDir, '.cache/packaging');
  await fs.mkdir(dist, { recursive: true });
  const file = path.join(dist, 'Private Client-Setup.exe');
  const content = Buffer.from('fixture installer');
  await fs.writeFile(file, content);
  const report = { artifacts: [{ file, bytes: content.length, sha256: hash(content) }] };
  await fs.writeFile(path.join(dist, 'build-verification.json'), JSON.stringify(report));
  return { ...f, prepared, dist, file, content, report };
}

test('installer collection verifies hashes and yields a single copy under build_dist', async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.dist, 'old-installer.exe'), 'old installer must not be collected');
  const first = await collectArtifacts(f);
  assert.equal(first.outputDir, path.join(f.root, 'build_dist', 'windows'));
  assert.deepEqual((await fs.readdir(first.outputDir)).sort(), [
    'Private Client-Setup.exe',
    'build-info.json',
  ]);
  assert.deepEqual(
    await fs.readFile(path.join(first.outputDir, 'Private Client-Setup.exe')),
    f.content,
  );
  // No second installer copy survives anywhere: the build cache is stripped.
  await assert.rejects(fs.access(f.file), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.dist, 'old-installer.exe')), { code: 'ENOENT' });
  // A rebuild replaces the installer in place instead of adding directories.
  await fs.writeFile(path.join(first.outputDir, 'Old Product-Setup.exe'), 'stale build');
  const rebuilt = Buffer.from('rebuilt installer');
  await fs.writeFile(f.file, rebuilt);
  const rebuildReport = {
    artifacts: [{ file: f.file, bytes: rebuilt.length, sha256: hash(rebuilt) }],
  };
  await fs.writeFile(path.join(f.dist, 'build-verification.json'), JSON.stringify(rebuildReport));
  const second = await collectArtifacts(f);
  assert.equal(second.outputDir, first.outputDir);
  assert.deepEqual((await fs.readdir(second.outputDir)).sort(), [
    'Private Client-Setup.exe',
    'build-info.json',
  ]);
  assert.deepEqual(
    await fs.readFile(path.join(second.outputDir, 'Private Client-Setup.exe')),
    rebuilt,
  );
  assert.equal(second.manifest.profileSha256, f.profile.sha256);
  const manifest = await fs.readFile(path.join(second.outputDir, 'build-info.json'), 'utf8');
  assert.equal(JSON.parse(manifest).upstream.commit, f.upstream.commit);
  assert.ok(!manifest.includes('private.example.invalid'));
});

test('tampered installers and paths outside the upstream dist directory are rejected', async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(f.file, 'tampered package');
  await assert.rejects(collectArtifacts(f), /does not match/);
  f.report.artifacts[0].file = path.join(f.root, 'outside.exe');
  await fs.writeFile(path.join(f.dist, 'build-verification.json'), JSON.stringify(f.report));
  await assert.rejects(collectArtifacts(f), /unexpected installer path/);
  await assert.rejects(fs.access(path.join(f.root, 'build_dist')), { code: 'ENOENT' });
});

test('empty artifact reports cannot produce successful output', async (t) => {
  const f = await artifactFixture(t);
  await fs.writeFile(path.join(f.dist, 'build-verification.json'), '{"artifacts":[]}');
  await assert.rejects(collectArtifacts(f), /did not report any installers/);
});

const nativePlatform = { win32: 'windows', darwin: 'macos' }[process.platform];

test(
  'the unified installer builds without a platform argument and honors installation opt-out',
  { skip: !nativePlatform },
  async (t) => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, 'custom-config'));
    await fs.copyFile(f.profileFile, path.join(f.root, 'custom-config/client.ovpn'));
    let setups = 0;
    const prepareEnvironment = async ({ root, platform }) => {
      assert.equal(root, f.root);
      assert.equal(platform, nativePlatform);
      setups++;
    };
    await runBuild([], { root: f.root, prepareEnvironment });
    assert.equal(setups, 1);
    const output = path.join(f.root, 'build_dist', nativePlatform);
    const expected =
      nativePlatform === 'windows' ? 'Private Client-Setup.exe' : 'Private Client.dmg';
    assert.deepEqual((await fs.readdir(output)).sort(), ['build-info.json', expected].sort());
    await assert.rejects(
      fs.access(
        path.join(f.root, '.cache/work', nativePlatform, 'source', '.cache', 'packaging', expected),
      ),
      { code: 'ENOENT' },
    );
    await runBuild(['--no-auto-install-deps'], { root: f.root, prepareEnvironment });
    assert.equal(setups, 1);
    assert.deepEqual((await fs.readdir(output)).sort(), ['build-info.json', expected].sort());
  },
);

test(
  'missing profiles and prepare-only mode never install dependencies',
  { skip: !nativePlatform },
  async (t) => {
    const f = await fixture(t);
    const prepareEnvironment = async () => {
      assert.fail('Dependency installation must not run.');
    };
    await assert.rejects(
      runBuild([], { root: f.root, prepareEnvironment }),
      /Private profile not found/,
    );
    await runBuild(['--prepare-only', '--profile', f.profileFile], {
      root: f.root,
      prepareEnvironment,
    });
    await assert.rejects(fs.access(path.join(f.root, 'build_dist')), { code: 'ENOENT' });
  },
);

test(
  'dependency setup returns the environment and propagates failures without stale state',
  { skip: !nativePlatform },
  async (t) => {
    const f = await fixture(t);
    const setupDirectory = path.join(f.root, 'make', nativePlatform);
    await fs.mkdir(setupDirectory, { recursive: true });
    const helper = path.join(f.root, 'fake-setup.mjs');
    await fs.writeFile(
      helper,
      `import fs from 'node:fs';
fs.writeFileSync(process.env.OPENVPN_BUILD_ENV_FILE, JSON.stringify({
  PATH: process.env.PATH || process.env.Path,
  RUSTUP_TOOLCHAIN: 'fixture-toolchain',
  OPENSSL_ROOT_DIR: 'C:/fixture/OpenSSL With Spaces'
}));`,
    );
    await fs.writeFile(
      path.join(setupDirectory, nativePlatform === 'windows' ? 'setup.ps1' : 'setup.sh'),
      nativePlatform === 'windows'
        ? "& $env:OPENVPN_BUILD_NODE (Join-Path $PSScriptRoot '../../fake-setup.mjs')\nexit $LASTEXITCODE\n"
        : '#!/usr/bin/env bash\nset -euo pipefail\n"$OPENVPN_BUILD_NODE" fake-setup.mjs\n',
    );
    const originalPath = process.env.PATH;
    const originalToolchain = process.env.RUSTUP_TOOLCHAIN;
    const originalOpenSsl = process.env.OPENSSL_ROOT_DIR;
    try {
      await setupEnvironment({ root: f.root, platform: nativePlatform });
      assert.equal(process.env.RUSTUP_TOOLCHAIN, 'fixture-toolchain');
      assert.equal(process.env.OPENSSL_ROOT_DIR, 'C:/fixture/OpenSSL With Spaces');
      assert.ok(process.env.PATH.startsWith(path.dirname(process.execPath) + path.delimiter));
      await fs.writeFile(helper, 'process.exit(17);');
      await assert.rejects(setupEnvironment({ root: f.root, platform: nativePlatform }), /exit 17/);
      assert.deepEqual(await fs.readdir(path.join(f.root, '.cache/work', nativePlatform)), []);
    } finally {
      process.env.PATH = originalPath;
      if (originalToolchain === undefined) delete process.env.RUSTUP_TOOLCHAIN;
      else process.env.RUSTUP_TOOLCHAIN = originalToolchain;
      if (originalOpenSsl === undefined) delete process.env.OPENSSL_ROOT_DIR;
      else process.env.OPENSSL_ROOT_DIR = originalOpenSsl;
    }
  },
);

test(
  'Windows OpenSSL SDK discovery, Light 4.x isolation and archive integrity',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t);
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(projectRoot, 'make/tests/unified/windows-openssl.Tests.ps1'),
        '-WorkDirectory',
        f.root,
      ],
      { encoding: 'utf8', stdio: 'pipe', windowsHide: true },
    );
  },
);

test(
  'native packaging dispatches the upstream script and collects this profile',
  { skip: !nativePlatform },
  async (t) => {
    const f = await fixture(t);
    const prepared = await prepareSource({ ...f, platform: nativePlatform });
    await buildPackage(prepared, {});
    const result = await collectArtifacts({ ...f, prepared });
    assert.deepEqual(
      await fs.readFile(path.join(result.outputDir, result.manifest.artifacts[0].file)),
      f.profile.contents,
    );
  },
);

test(
  'packaging errors propagate and invalidate the previous artifact report',
  { skip: !nativePlatform },
  async (t) => {
    const f = await fixture(t);
    const prepared = await prepareSource({ ...f, platform: nativePlatform });
    const script =
      nativePlatform === 'windows' ? 'make/windows/package.ps1' : 'make/macos/package.sh';
    await fs.writeFile(path.join(prepared.sourceDir, script), 'exit 23\n');
    const dist = path.join(prepared.sourceDir, '.cache/packaging');
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(
      path.join(dist, 'build-verification.json'),
      '{"artifacts":[{"file":"old.exe"}]}',
    );
    await assert.rejects(buildPackage(prepared, {}), /exit 23/);
    await assert.rejects(fs.access(path.join(dist, 'build-verification.json')), { code: 'ENOENT' });
  },
);
