// Called only after compiling and copying the engine on Windows and macOS.
// Ship upstream licenses and provenance; source archives are not bundled.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashFile, readRelease, projectRoot } from './openvpn3-release.mjs';

const [source, binary, platform, tapComponentId, configuration = 'Release'] = process.argv.slice(2);
const release = await readRelease();
const git = (...args) =>
  execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
const commit = git('rev-parse', 'HEAD').trim();
const header = await fs.readFile(path.join(source, 'openvpn/common/version.hpp'), 'utf8');
if (commit !== release.commit || !header.includes(`#define OPENVPN_VERSION "${release.version}"`))
  throw new Error('Compiled source does not match the OpenVPN release lock.');
const directory = path.dirname(binary);
const legal = path.join(projectRoot, 'LICENSES/openvpn3');
await fs.mkdir(legal, { recursive: true });
await fs.copyFile(path.join(source, 'LICENSE.md'), path.join(legal, 'LICENSE.md'));
await fs.cp(path.join(source, 'LICENSES'), path.join(legal, 'LICENSES'), { recursive: true });
await fs.writeFile(
  path.join(directory, 'ovpncli-build.json'),
  JSON.stringify(
    {
      version: release.version,
      sourceRef: release.ref,
      sourceCommit: commit,
      platform,
      ...(tapComponentId ? { tapComponentId } : {}),
      configuration,
      sha256: await hashFile(binary),
    },
    null,
    2,
  ) + '\n',
);
console.log(`Recorded OpenVPN ${release.version} provenance and licenses (${commit}).`);
