import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { projectRoot, verifyEngineRelease } from '../openvpn3-release.mjs';
import { createTempDirectory } from '../lib/paths.mjs';

export const driverManifest = JSON.parse(
  await fs.readFile(path.join(projectRoot, 'config/windows-tap-driver.json'), 'utf8'),
);

export async function sha256(file) {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

export async function verifyDriverFiles(directory) {
  for (const [name, expected] of Object.entries(driverManifest.files)) {
    if ((await sha256(path.join(directory, name))) !== expected) {
      throw new Error(`Bundled TAP driver checksum mismatch: ${name}`);
    }
  }
}

export async function verifyWindowsEngine(root = projectRoot) {
  const directory = path.join(root, '.cache/native/bin/windows-x64');
  const instructions = 'Run npm run package:win -- -ForceOpenVpnBuild to build the tap0901 engine.';
  let metadata;
  try {
    metadata = JSON.parse(
      (await fs.readFile(path.join(directory, 'ovpncli-build.json'), 'utf8')).replace(
        /^\uFEFF/,
        '',
      ),
    );
  } catch {
    throw new Error(`OpenVPN build metadata is missing or invalid. ${instructions}`);
  }
  if (metadata.tapComponentId !== 'tap0901' || metadata.platform !== 'x64') {
    throw new Error(
      `The standalone Windows installer requires an x64 tap0901 engine. ${instructions}`,
    );
  }
  if (metadata.sha256?.toLowerCase() !== (await sha256(path.join(directory, 'ovpncli.exe')))) {
    throw new Error(`ovpncli.exe does not match its build metadata. ${instructions}`);
  }
  await verifyEngineRelease(path.join(directory, 'ovpncli.exe'), root);
  const files = await fs.readdir(directory);
  if (
    !files.some((name) => /^libssl-.*\.dll$/i.test(name)) ||
    !files.some((name) => /^libcrypto-.*\.dll$/i.test(name))
  ) {
    throw new Error('The Windows OpenVPN bundle must include the OpenSSL SSL and Crypto DLLs.');
  }
}

async function fetchVerified(asset, cacheDirectory) {
  const destination = path.join(cacheDirectory, asset.name);
  try {
    if ((await sha256(destination)) === asset.sha256) return destination;
    throw new Error(`Cached driver asset checksum mismatch: ${destination}. Remove it and retry.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.log(`Downloading TAP-Windows6 ${driverManifest.version}: ${asset.name}`);
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${asset.url}`);
  const contents = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(contents).digest('hex') !== asset.sha256) {
    throw new Error(`Downloaded driver asset checksum mismatch: ${asset.url}`);
  }
  await fs.writeFile(destination, contents);
  return destination;
}

export async function prepareWindowsDriver(root = projectRoot) {
  const cacheDirectory = path.join(root, '.cache/tap-windows6');
  const outputDirectory = path.join(root, '.cache/native/drivers/windows-x64/tap-windows6');
  await fs.mkdir(cacheDirectory, { recursive: true });
  const archive = await fetchVerified(driverManifest.archive, cacheDirectory);
  const temporaryDirectory = await createTempDirectory('openvpn-tap-', root);
  try {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:OVPN_DRIVER_ARCHIVE, $env:OVPN_DRIVER_EXTRACT)",
        ],
        {
          windowsHide: true,
          env: {
            ...process.env,
            OVPN_DRIVER_ARCHIVE: archive,
            OVPN_DRIVER_EXTRACT: temporaryDirectory,
          },
          stdio: 'pipe',
        },
      );
    } else {
      execFileSync('unzip', ['-q', archive, '-d', temporaryDirectory], { stdio: 'pipe' });
    }
    const extracted = path.join(temporaryDirectory, 'dist.win10/amd64');
    await verifyDriverFiles(extracted);
    await fs.mkdir(outputDirectory, { recursive: true });
    for (const name of Object.keys(driverManifest.files)) {
      await fs.copyFile(path.join(extracted, name), path.join(outputDirectory, name));
    }
    for (const name of [
      'LICENSE.tap-windows6.txt',
      'COPYRIGHT.GPL',
      'LICENSE.devcon.txt',
      'THIRD-PARTY-NOTICES.txt',
    ]) {
      await fs.copyFile(
        path.join(root, 'LICENSES/tap-windows6', name),
        path.join(outputDirectory, name),
      );
    }
    // Keep the source URL in the manifest, but ship only licenses and runtime files.
    // Remove the archive left by older staging runs so it cannot enter a new bundle.
    await fs.rm(path.join(outputDirectory, driverManifest.source.name), { force: true });
    await fs.writeFile(
      path.join(outputDirectory, 'manifest.json'),
      JSON.stringify(driverManifest, null, 2) + '\n',
    );
    console.log(`Bundled TAP-Windows6 ${driverManifest.version} (tap0901, Windows x64).`);
  } finally {
    // mkdtemp above creates this private directory; never remove a caller-supplied path.
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
  return outputDirectory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareWindowsDriver();
}
