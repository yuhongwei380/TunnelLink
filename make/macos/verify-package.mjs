import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function runMacTool(command, args) {
  if (process.platform !== 'darwin')
    throw new Error('Verify macOS packages on a Mac with codesign, hdiutil and spctl.');
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
}

function details(result) {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim();
}

function requireSuccess(command, args, run, phase) {
  const result = run(command, args);
  if (result.error || result.status !== 0)
    throw new Error(`${phase}: ${details(result) || `exit ${result.status ?? 'unknown'}`}`);
  return result;
}

export function verifyMacPackage(app, diskImages, { run = runMacTool } = {}) {
  if (!diskImages.length) throw new Error('No macOS DMG was generated for verification.');
  requireSuccess(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', app],
    run,
    `Invalid macOS application signature (${app})`,
  );
  const signature = details(
    requireSuccess(
      'codesign',
      ['--display', '--verbose=4', app],
      run,
      'Cannot read macOS signature',
    ),
  );
  const authorities = [...signature.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]);
  const kind = /^Signature=adhoc$/m.test(signature)
    ? 'ad-hoc'
    : authorities.some((authority) => authority.startsWith('Developer ID Application:'))
      ? 'developer-id'
      : 'other';
  const images = diskImages.map((file) => {
    requireSuccess('hdiutil', ['verify', file], run, `Invalid macOS disk image (${file})`);
    return { file: path.basename(file), checksum: 'valid' };
  });
  // Signature integrity and Gatekeeper trust are separate checks. Local ad-hoc
  // builds remain available, but must never be reported as trusted releases.
  const assessment = run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  return {
    applicationSignature: { valid: true, kind, authorities },
    diskImages: images,
    gatekeeper: {
      acceptedOnBuildMachine: !assessment.error && assessment.status === 0,
      details: details(assessment),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3])
    throw new Error('Usage: node make/macos/verify-package.mjs /path/App.app /path/Installer.dmg');
  const result = verifyMacPackage(process.argv[2], process.argv.slice(3));
  console.log(JSON.stringify(result, null, 2));
  if (!result.gatekeeper.acceptedOnBuildMachine) process.exitCode = 2;
}
