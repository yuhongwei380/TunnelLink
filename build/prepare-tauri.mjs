import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { verifyWindowsEngine, prepareWindowsDriver } from './windows/prepare-driver.mjs';
import { verifyMacRuntime, targetMacArchitectures } from './macos/verify-runtime.mjs';
import { verifyEngineRelease, hashFile } from './openvpn3-release.mjs';

export async function prepareTauri({ root, platform, arch }) {
  if (platform === 'win32') {
    if (arch !== 'x64' && arch !== 'x86_64')
      throw new Error('The bundled Windows TAP driver supports x64 installers only.');
    await verifyWindowsEngine(root);
    await prepareWindowsDriver(root);
  } else if (platform === 'darwin') {
    const architectures = targetMacArchitectures(arch);
    const binary = path.join(root, 'native/bin/macos/ovpncli');
    await verifyMacRuntime(binary, { architectures });
    const metadata = await verifyEngineRelease(binary, root);
    // install_name_tool changes invalidate Mach-O signatures. Sign at build time,
    // before packaging; the user's Mac never needs Xcode tools or runtime relinking.
    const identity = process.env.APPLE_SIGNING_IDENTITY || '-';
    const sign = (file) =>
      execFileSync(
        'codesign',
        [
          '--force',
          '--sign',
          identity,
          ...(identity === '-' ? ['--timestamp=none'] : ['--options', 'runtime', '--timestamp']),
          file,
        ],
        { stdio: 'pipe' },
      );
    const libDir = path.join(path.dirname(binary), 'lib');
    for (const name of await fs.readdir(libDir).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      if (name.endsWith('.dylib')) sign(path.join(libDir, name));
    }
    sign(binary);
    // Signing legitimately changes the file hash; update only after checking the
    // previous binary and its source against the release lock above.
    metadata.sha256 = await hashFile(binary);
    await fs.writeFile(
      path.join(path.dirname(binary), 'ovpncli-build.json'),
      JSON.stringify(metadata, null, 2) + '\n',
    );
  } else {
    throw new Error('This VPN client currently supports Windows and macOS.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await prepareTauri({
    root,
    platform: process.platform,
    arch: process.env.TAURI_ENV_ARCH || process.arch,
  });
  console.log('Verified the native OpenVPN runtime and platform resources for Tauri.');
}
