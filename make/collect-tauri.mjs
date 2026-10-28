import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyMacRuntime } from './macos/verify-runtime.mjs';

export async function collectTauri(root, args, env) {
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : '';
  const targetRoot = env.CARGO_TARGET_DIR
    ? path.resolve(root, env.CARGO_TARGET_DIR)
    : path.join(root, 'src-tauri/target');
  const buildRoot = path.join(targetRoot, target, args.includes('--debug') ? 'debug' : 'release');
  const output = path.join(root, 'make/dist');
  await fs.mkdir(output, { recursive: true });
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const branding = JSON.parse(
    await fs.readFile(path.join(root, 'config/app-branding.json'), 'utf8'),
  );
  const artifacts = [];
  if (process.platform === 'win32') {
    const directory = path.join(buildRoot, 'bundle/nsis');
    // Older releases remain in Cargo's output tree. Never relabel an old
    // installer with the current package version when collecting artifacts.
    const files = (await fs.readdir(directory)).filter(
      (name) => name === `${branding.productName}_${pkg.version}_x64-setup.exe`,
    );
    for (const file of files) {
      const destination = path.join(
        output,
        `${branding.productName}-Tauri-Setup-${pkg.version}-x64.exe`,
      );
      await fs.copyFile(path.join(directory, file), destination);
      artifacts.push(destination);
    }
  } else if (process.platform === 'darwin') {
    const app = path.join(buildRoot, 'bundle/macos', `${branding.productName}.app`);
    await verifyMacRuntime(path.join(app, 'Contents/Resources/bin/macos/ovpncli'));
    const directory = path.join(buildRoot, 'bundle/dmg');
    for (const file of (await fs.readdir(directory)).filter(
      (name) => name.startsWith(`${branding.productName}_${pkg.version}_`) && name.endsWith('.dmg'),
    )) {
      const destination = path.join(output, file);
      await fs.copyFile(path.join(directory, file), destination);
      artifacts.push(destination);
    }
  }
  if (!artifacts.length) throw new Error('No Tauri installer was generated.');
  // The collected copy in make/dist is the one deliverable. Remove the
  // installer(s) still sitting in Cargo's bundle tree (current and older
  // releases) so a filesystem search never finds two identical setups.
  for (const directory of [
    path.join(buildRoot, 'bundle/nsis'),
    path.join(buildRoot, 'bundle/dmg'),
  ]) {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.(exe|dmg|msi)$/i.test(name)) continue;
      await fs.rm(path.join(directory, name));
      console.log(`Removed bundled installer: ${path.join(directory, name)}`);
    }
  }
  // make/dist keeps exactly the installer(s) of this build; previous runs
  // (older versions or renamed products) must not pile up next to it.
  const keep = new Set(artifacts.map((file) => path.resolve(file)));
  for (const name of await fs.readdir(output)) {
    const file = path.join(output, name);
    if (!/\.(exe|dmg|msi)$/i.test(name) || keep.has(path.resolve(file))) continue;
    await fs.rm(file);
    console.log(`Removed stale installer: ${file}`);
  }
  const verification = {
    framework: 'Tauri 2',
    version: pkg.version,
    builtAt: new Date().toISOString(),
    artifacts: [],
  };
  for (const file of artifacts) {
    const content = await fs.readFile(file);
    verification.artifacts.push({
      file,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    console.log(`Installer: ${file}`);
  }
  await fs.writeFile(
    path.join(output, 'build-verification.json'),
    JSON.stringify(verification, null, 2) + '\n',
  );
}
