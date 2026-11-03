import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createTempDirectory } from '../lib/paths.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTauri } from '../prepare-tauri.mjs';
import {
  parseDependencies,
  parseRpaths,
  verifyMacRuntime,
  targetMacArchitectures,
} from '../macos/verify-runtime.mjs';
import { verifyMacPackage } from '../macos/verify-package.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function fixture(t, definitions) {
  const directory = await createTempDirectory('openvpn-mac-test-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime');
  const images = new Map();
  for (const [name, definition] of Object.entries(definitions)) {
    const file = path.join(runtime, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'Mach-O test fixture (not an executable)');
    await fs.chmod(file, 0o755);
    images.set(path.basename(file), {
      architectures: ['arm64'],
      dependencies: [],
      ids: [],
      rpaths: [],
      ...definition,
    });
  }
  return {
    directory,
    binary: path.join(runtime, 'ovpncli'),
    inspect: (file) => {
      const image = images.get(path.basename(file));
      assert.ok(image, `Unexpected image: ${file}`);
      return image;
    },
  };
}

test('otool parsing preserves spaces, ignores fat headers, and deduplicates load commands', () => {
  const output =
    '/path/ovpncli (architecture arm64):\n\t@executable_path/lib/a library.dylib (compatibility version 1.0.0, current version 1.0.0)\n/path/ovpncli (architecture x86_64):\n\t@executable_path/lib/a library.dylib (compatibility version 1.0.0, current version 1.0.0)\n';
  assert.deepEqual(parseDependencies(output), ['@executable_path/lib/a library.dylib']);
  assert.deepEqual(
    parseRpaths(
      'Load command 10\n          cmd LC_RPATH\n      cmdsize 40\n         path @executable_path/lib (offset 12)\n',
    ),
    ['@executable_path/lib'],
  );
});

test('macOS targets use Tauri architecture names and reject unknown targets', () => {
  assert.deepEqual(targetMacArchitectures('aarch64'), ['arm64']);
  assert.deepEqual(targetMacArchitectures('arm64'), ['arm64']);
  assert.deepEqual(targetMacArchitectures('x64'), ['x86_64']);
  assert.deepEqual(targetMacArchitectures('x86_64'), ['x86_64']);
  assert.deepEqual(targetMacArchitectures('universal'), ['x86_64', 'arm64']);
  assert.throws(() => targetMacArchitectures('ia32'), /Unsupported macOS/);
  assert.throws(() => targetMacArchitectures(4), /Unsupported macOS/);
});

test('macOS DMG presents the standard Applications drag target', async () => {
  const config = JSON.parse(
    await fs.readFile(path.join(projectRoot, 'ui/src-tauri/tauri.macos.conf.json'), 'utf8'),
  );
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.deepEqual(config.bundle.macOS.dmg, {
    windowSize: { width: 660, height: 400 },
    appPosition: { x: 180, y: 170 },
    applicationFolderPosition: { x: 480, y: 170 },
  });
  const nativeSource = await fs.readFile(path.join(projectRoot, 'ui/src-tauri/src/lib.rs'), 'utf8');
  assert.match(nativeSource, /resource_dir\(\)/);
  assert.match(nativeSource, /app_install_to_applications/);
});

test('bundled transitive libraries validate while system libraries remain external', async (t) => {
  const f = await fixture(t, {
    ovpncli: { dependencies: ['@executable_path/lib/libssl.dylib', '/usr/lib/libSystem.B.dylib'] },
    'lib/libssl.dylib': {
      dependencies: ['@rpath/libssl.dylib', '@loader_path/libcrypto.dylib'],
      ids: ['@rpath/libssl.dylib'],
    },
    'lib/libcrypto.dylib': {
      dependencies: ['/System/Library/Frameworks/Security.framework/Versions/A/Security'],
    },
  });
  assert.deepEqual(
    await verifyMacRuntime(f.binary, { inspect: f.inspect, architectures: ['arm64'] }),
    {
      files: 3,
      architectures: ['arm64'],
    },
  );
});

test('missing transitive dylibs fail packaging', async (t) => {
  const f = await fixture(t, {
    ovpncli: { dependencies: ['@executable_path/lib/libssl.dylib'] },
    'lib/libssl.dylib': { dependencies: ['@loader_path/libcrypto.dylib'] },
  });
  await assert.rejects(
    verifyMacRuntime(f.binary, { inspect: f.inspect }),
    /Missing bundled macOS library.*libcrypto/,
  );
});

test('absolute dependencies outside Homebrew paths are also rejected', async (t) => {
  const f = await fixture(t, { ovpncli: { dependencies: ['/Users/builder/custom/libssl.dylib'] } });
  await assert.rejects(
    verifyMacRuntime(f.binary, { inspect: f.inspect }),
    /External macOS library dependency/,
  );
});

test('rpath resolution follows the executable runpath for transitive libraries', async (t) => {
  const f = await fixture(t, {
    ovpncli: { rpaths: ['@executable_path/lib'], dependencies: ['@rpath/libssl.dylib'] },
    'lib/libssl.dylib': { dependencies: ['@rpath/libcrypto.dylib'] },
    'lib/libcrypto.dylib': {},
  });
  assert.equal((await verifyMacRuntime(f.binary, { inspect: f.inspect })).files, 3);
});

test('unresolved rpaths fail packaging', async (t) => {
  const f = await fixture(t, { ovpncli: { dependencies: ['@rpath/libssl.dylib'] } });
  await assert.rejects(
    verifyMacRuntime(f.binary, { inspect: f.inspect }),
    /Missing bundled macOS library/,
  );
});

test('relative library paths may not escape the bundled runtime', async (t) => {
  const f = await fixture(t, { ovpncli: { dependencies: ['@loader_path/../outside.dylib'] } });
  await fs.writeFile(path.join(f.directory, 'outside.dylib'), 'outside');
  await assert.rejects(
    verifyMacRuntime(f.binary, { inspect: f.inspect }),
    /escapes the bundled runtime/,
  );
});

test('wrong-architecture libraries block a package even when the main executable matches', async (t) => {
  const f = await fixture(t, {
    ovpncli: { dependencies: ['@executable_path/lib/libssl.dylib'] },
    'lib/libssl.dylib': { architectures: ['x86_64'] },
  });
  await assert.rejects(
    verifyMacRuntime(f.binary, { inspect: f.inspect, architectures: ['arm64'] }),
    /architecture mismatch.*libssl/,
  );
});

test('universal packages require both architectures in every bundled image', async (t) => {
  const f = await fixture(t, {
    ovpncli: { architectures: ['arm64', 'x86_64'] },
    'lib/libextra.dylib': {},
  });
  await assert.rejects(
    verifyMacRuntime(f.binary, {
      inspect: f.inspect,
      architectures: targetMacArchitectures('universal'),
    }),
    /does not contain x86_64/,
  );
});

test('Tauri Mac packaging rejects missing engines before bundling', async (t) => {
  const f = await fixture(t, {});
  await assert.rejects(
    prepareTauri({ platform: 'darwin', arch: 'arm64', root: f.directory }),
    /ovpncli is missing/,
  );
});

function packageTools({ signature = 'Signature=adhoc', accepted = false, failure } = {}) {
  const calls = [];
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args });
      if (failure?.command === command && failure?.option === args[0]) return failure.result;
      if (command === 'codesign' && args[0] === '--display')
        return { status: 0, stdout: '', stderr: signature };
      if (command === 'spctl')
        return { status: accepted ? 0 : 3, stdout: '', stderr: accepted ? 'accepted' : 'rejected' };
      return { status: 0, stdout: 'verified', stderr: '' };
    },
  };
}

const app = '/build/App With Spaces.app';
const dmg = '/build/App With Spaces.dmg';

test('valid ad-hoc signatures and disk images are not reported as Gatekeeper approved', () => {
  const tools = packageTools();
  const report = verifyMacPackage(app, [dmg], tools);
  assert.equal(report.applicationSignature.valid, true);
  assert.equal(report.applicationSignature.kind, 'ad-hoc');
  assert.equal(report.gatekeeper.acceptedOnBuildMachine, false);
  assert.equal(report.gatekeeper.details, 'rejected');
  assert.deepEqual(report.diskImages, [{ file: 'App With Spaces.dmg', checksum: 'valid' }]);
  assert.ok(tools.calls.every(({ command }) => !['osascript', 'open'].includes(command)));
});

test('Developer ID signatures still require a separate successful Gatekeeper assessment', () => {
  for (const accepted of [true, false]) {
    const tools = packageTools({
      signature: 'Authority=Developer ID Application: Example (TEAMID)\nAuthority=Apple Root CA',
      accepted,
    });
    const report = verifyMacPackage(app, [dmg], tools);
    assert.equal(report.applicationSignature.kind, 'developer-id');
    assert.equal(report.gatekeeper.acceptedOnBuildMachine, accepted);
  }
});

test('invalid application signatures stop packaging before disk image assessment', () => {
  const tools = packageTools({
    failure: {
      command: 'codesign',
      option: '--verify',
      result: { status: 1, stderr: 'a sealed resource is missing or invalid' },
    },
  });
  assert.throws(
    () => verifyMacPackage(app, [dmg], tools),
    /Invalid macOS application signature.*sealed resource/,
  );
  assert.equal(tools.calls.length, 1);
});

test('damaged disk images stop packaging instead of producing a successful report', () => {
  const tools = packageTools({
    failure: {
      command: 'hdiutil',
      option: 'verify',
      result: { status: 1, stderr: 'checksum verification failed' },
    },
  });
  assert.throws(
    () => verifyMacPackage(app, [dmg], tools),
    /Invalid macOS disk image.*checksum verification failed/,
  );
  assert.ok(!tools.calls.some(({ command }) => command === 'spctl'));
});

test('missing tools and absent DMG outputs cannot pass package verification', () => {
  assert.throws(() => verifyMacPackage(app, [], packageTools()), /No macOS DMG/);
  const tools = packageTools({
    failure: {
      command: 'codesign',
      option: '--verify',
      result: { status: null, error: new Error('codesign was not found') },
    },
  });
  assert.throws(() => verifyMacPackage(app, [dmg], tools), /codesign was not found/);
});
