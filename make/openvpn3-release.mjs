import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hashFile = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
export async function readRelease(root = projectRoot) {
  const release = JSON.parse(
    await fs.readFile(path.join(root, 'resources/settings/openvpn3-release.json'), 'utf8'),
  );
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    release.ref !== `release/${release.version}` ||
    !/^[a-f0-9]{40}$/.test(release.commit)
  ) {
    throw new Error(
      'Invalid OpenVPN release lock: version, release tag and commit must be pinned.',
    );
  }
  return release;
}
export async function verifyEngineRelease(binary, root = projectRoot) {
  const release = await readRelease(root);
  const directory = path.dirname(binary);
  const metadata = JSON.parse(
    (await fs.readFile(path.join(directory, 'ovpncli-build.json'), 'utf8')).replace(/^\uFEFF/, ''),
  );
  if (
    metadata.version !== release.version ||
    metadata.sourceRef !== release.ref ||
    metadata.sourceCommit !== release.commit
  ) {
    throw new Error(
      `OpenVPN release mismatch: rebuild the engine from ${release.ref} (${release.commit}).`,
    );
  }
  if (metadata.sha256 !== (await hashFile(binary)))
    throw new Error('OpenVPN engine does not match its build metadata.');
  return metadata;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await verifyEngineRelease(path.resolve(process.argv[2]));
}
