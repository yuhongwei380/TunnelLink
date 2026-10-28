import fs from 'node:fs/promises';
import { createTempDirectory } from '../../lib/paths.mjs';
import path from 'node:path';
import { projectRoot as root, readRelease } from '../../openvpn3-release.mjs';
import { sha256 } from '../../windows/prepare-driver.mjs';

export async function engineFixture(t) {
  const directory = await createTempDirectory('openvpn-engine-test-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, '.cache/native/bin/windows-x64');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'ovpncli.exe'), 'test-engine');
  await fs.writeFile(path.join(bin, 'libssl-3-x64.dll'), 'test-ssl');
  await fs.writeFile(path.join(bin, 'libcrypto-3-x64.dll'), 'test-crypto');
  const release = await readRelease(root);
  await fs.mkdir(path.join(directory, 'config'));
  await fs.copyFile(
    path.join(root, 'config/openvpn3-release.json'),
    path.join(directory, 'config/openvpn3-release.json'),
  );
  const metadata = {
    version: release.version,
    sourceRef: release.ref,
    sourceCommit: release.commit,
    platform: 'x64',
    tapComponentId: 'tap0901',
    sha256: await sha256(path.join(bin, 'ovpncli.exe')),
  };
  const save = () =>
    fs.writeFile(path.join(bin, 'ovpncli-build.json'), '\uFEFF' + JSON.stringify(metadata));
  await save();
  return { directory, bin, metadata, save };
}
