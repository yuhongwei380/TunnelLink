import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function verifyDesktopStack(root) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const packages = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(lock.packages || {}),
  ];
  const forbidden = packages.filter((name) =>
    /(?:^|\/)(?:@electron(?:-forge)?\/|electron(?:-[^/]+)?(?:$|\/)|@electron\/asar|asar(?:$|\/))/.test(
      name,
    ),
  );
  if (forbidden.length)
    throw new Error(`Unexpected desktop dependencies: ${[...new Set(forbidden)].join(', ')}`);
  if (!pkg.dependencies?.['@tauri-apps/api'] || !pkg.devDependencies?.['@tauri-apps/cli'])
    throw new Error('Tauri API and CLI must be configured.');
  if (pkg.main || pkg.build || pkg.config?.forge)
    throw new Error('Obsolete desktop package configuration: use src-tauri/tauri.conf.json.');
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (/\belectron(?:-[\w-]+)?\b|(?:before|after)-pack\.(?:cjs|mjs|js)\b/i.test(command))
      throw new Error(`Obsolete desktop script: ${name}`);
  }
  for (const entry of [
    'electron',
    'electron-builder.yml',
    'electron-builder.yaml',
    'electron-builder.json',
    'electron-builder.json5',
    'forge.config.js',
    'forge.config.cjs',
    'forge.config.ts',
    'build/before-pack.cjs',
    'build/after-pack.cjs',
    'build/installer/windows-driver.nsh',
    'build/build-win-in-docker.sh',
  ]) {
    const exists = await fs.stat(path.join(root, entry)).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (exists) throw new Error(`Obsolete desktop entry still exists: ${entry}`);
  }
  for (const name of ['tauri.conf.json', 'tauri.windows.conf.json', 'tauri.macos.conf.json']) {
    const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri', name), 'utf8'));
    if (/electron/i.test(JSON.stringify(config)))
      throw new Error(`Obsolete desktop resource reference in ${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await verifyDesktopStack(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('Verified Tauri desktop configuration, dependency lock and resource paths.');
}
