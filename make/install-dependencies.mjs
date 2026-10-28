import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function installDependencies(
  root = projectRoot,
  install = () => {
    const windows = process.platform === 'win32';
    const result = spawnSync(
      windows ? 'cmd.exe' : 'npm',
      windows ? ['/d', '/s', '/c', 'npm ci --prefer-offline'] : ['ci', '--prefer-offline'],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    if (result.error || result.status !== 0)
      throw new Error(`npm ci failed: ${result.error?.message ?? result.status}`);
  },
) {
  const manifest = await fs.readFile(path.join(root, 'package.json'));
  const lock = await fs.readFile(path.join(root, 'package-lock.json'));
  const key = createHash('sha256')
    .update(manifest)
    .update(lock)
    .update(`${process.version}/${process.platform}/${process.arch}`)
    .digest('hex');
  const modules = path.join(root, 'node_modules');
  const stamp = path.join(modules, '.openvpn-dependencies.json');
  const hiddenLock = path.join(modules, '.package-lock.json');
  const hiddenHash = async () =>
    createHash('sha256')
      .update(await fs.readFile(hiddenLock))
      .digest('hex');
  try {
    const previous = JSON.parse(await fs.readFile(stamp, 'utf8'));
    if (previous.key === key && previous.lockHash === (await hiddenHash())) {
      const pkg = JSON.parse(manifest);
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        await fs.access(path.join(modules, name, 'package.json'));
      }
      console.log('Node dependencies cache hit; skipping npm ci.');
      return false;
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
  }
  console.log('Node dependencies cache miss; installing from lockfile (prefer offline cache)...');
  await install();
  await fs.writeFile(stamp, JSON.stringify({ key, lockHash: await hiddenHash() }) + '\n');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await installDependencies();
}
