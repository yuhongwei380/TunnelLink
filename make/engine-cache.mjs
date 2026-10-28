import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { projectRoot, readRelease, verifyEngineRelease } from './openvpn3-release.mjs';

export async function verifyEngineCache({
  root = projectRoot,
  platform,
  arch,
  configuration = 'Release',
  tapComponentId = 'tap0901',
}) {
  const directory = path.join(
    root,
    '.cache/native/bin',
    platform === 'windows' ? 'windows-x64' : 'macos',
  );
  const binary = path.join(directory, platform === 'windows' ? 'ovpncli.exe' : 'ovpncli');
  const metadata = await verifyEngineRelease(binary, root);
  if (
    metadata.platform !== arch ||
    metadata.configuration !== configuration ||
    (platform === 'windows' && metadata.tapComponentId !== tapComponentId)
  ) {
    throw new Error('Cached engine architecture, configuration or TAP driver does not match.');
  }
  if (platform === 'windows') {
    const files = await fs.readdir(directory);
    if (
      !files.some((name) => /^libssl-.*\.dll$/i.test(name)) ||
      !files.some((name) => /^libcrypto-.*\.dll$/i.test(name))
    ) {
      throw new Error('Cached engine is missing OpenSSL runtime DLLs.');
    }
  }
  return binary;
}

export async function prepareEngineSource({ workDir, repository, release }) {
  const source = path.join(path.resolve(workDir), 'openvpn3');
  const git = (...args) =>
    execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  await fs.mkdir(workDir, { recursive: true });
  try {
    const stat = await fs.lstat(source);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Source cache must be a regular directory: ${source}`);
    if ((await fs.realpath(git('rev-parse', '--show-toplevel'))) !== (await fs.realpath(source))) {
      throw new Error(`Source cache must be a dedicated Git checkout: ${source}`);
    }
    if (git('remote', 'get-url', 'origin') !== repository)
      throw new Error(`Cached engine origin differs. Choose another work directory: ${source}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    execFileSync('git', ['init', '--quiet', source], { windowsHide: true });
    git('remote', 'add', 'origin', repository);
    git('config', 'core.autocrlf', 'false');
  }
  let head;
  try {
    head = git('rev-parse', '--verify', 'HEAD');
  } catch {
    /* Incomplete first fetch. */
  }
  if (head && head !== release.commit)
    throw new Error(`Cached engine commit differs. Choose another work directory: ${source}`);
  if (!head) {
    try {
      git('cat-file', '-e', `${release.commit}^{commit}`);
    } catch {
      console.log(`Engine source cache miss: fetching ${release.commit}...`);
      git('fetch', '--depth=1', 'origin', release.commit);
    }
    git('checkout', '--detach', release.commit);
  } else {
    console.log(`Engine source cache hit: ${source}`);
  }
  const header = await fs.readFile(path.join(source, 'openvpn/common/version.hpp'), 'utf8');
  if (!header.includes(`#define OPENVPN_VERSION "${release.version}"`))
    throw new Error('Cached source version does not match the release lock.');
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'verify') {
      const [platform, arch, configuration, tapComponentId] = args;
      const binary = await verifyEngineCache({ platform, arch, configuration, tapComponentId });
      console.log(`Engine binary cache hit: ${binary}`);
    } else if (command === 'source') {
      const [workDir, repository] = args;
      await prepareEngineSource({ workDir, repository, release: await readRelease() });
    } else throw new Error('Expected verify or source command.');
  } catch (error) {
    console.log(`Engine cache unavailable: ${error.message}`);
    process.exitCode = 1;
  }
}
