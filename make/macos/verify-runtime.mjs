import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseDependencies(output) {
  return [
    ...new Set(
      output.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^\s+(.+?)\s+\(compatibility version /);
        return match ? [match[1]] : [];
      }),
    ),
  ];
}

export function parseRpaths(output) {
  return [
    ...output.matchAll(/\bcmd LC_RPATH\r?\n\s+cmdsize \d+\r?\n\s+path (.+?) \(offset \d+\)/g),
  ].map((match) => match[1]);
}

function inspectMachO(file) {
  if (process.platform !== 'darwin')
    throw new Error('Inspect the macOS runtime on a Mac with otool and lipo installed.');
  const run = (tool, args) => execFileSync(tool, args, { encoding: 'utf8' });
  return {
    architectures: run('lipo', ['-archs', file]).trim().split(/\s+/),
    dependencies: parseDependencies(run('otool', ['-L', file])),
    ids: run('otool', ['-D', file])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(?:@|\/)/.test(line) && !line.endsWith(':')),
    rpaths: parseRpaths(run('otool', ['-l', file])),
  };
}

const isSystem = (file) => {
  const normalized = path.posix.normalize(file);
  return normalized.startsWith('/usr/lib/') || normalized.startsWith('/System/Library/');
};
const isWithin = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
};

export function targetMacArchitectures(arch) {
  const targets = {
    x64: ['x86_64'],
    x86_64: ['x86_64'],
    arm64: ['arm64'],
    aarch64: ['arm64'],
    universal: ['x86_64', 'arm64'],
  };
  if (!Object.hasOwn(targets, arch))
    throw new Error(`Unsupported macOS package architecture: ${arch}`);
  return targets[arch];
}

export async function verifyMacRuntime(binary, { architectures, inspect = inspectMachO } = {}) {
  binary = path.resolve(binary);
  try {
    await fs.access(binary, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(
      `macOS ovpncli is missing or not executable: ${binary}. Run npm run build:openvpn3:mac on a Mac.`,
    );
  }
  const root = await fs.realpath(path.dirname(binary));
  const executableDirectory = path.dirname(binary);
  const main = inspect(binary);
  const required = architectures ?? main.architectures;
  if (!required.length || required.some((arch) => !['x86_64', 'arm64'].includes(arch))) {
    throw new Error(`Unsupported macOS runtime architectures: ${required.join(', ')}`);
  }
  const checked = new Set();

  function expand(reference, loader) {
    if (reference.startsWith('@executable_path/'))
      return path.resolve(executableDirectory, reference.slice(17));
    if (reference.startsWith('@loader_path/'))
      return path.resolve(path.dirname(loader), reference.slice(13));
    if (path.isAbsolute(reference)) return reference;
    throw new Error(`Unsupported macOS library path ${reference} in ${loader}`);
  }

  async function resolveDependency(reference, loader, runpaths) {
    if (isSystem(reference)) return null;
    // An absolute path to a build machine is not relocatable, even if it exists.
    if (path.isAbsolute(reference))
      throw new Error(`External macOS library dependency: ${reference} in ${loader}`);
    let candidates;
    if (reference.startsWith('@rpath/')) {
      candidates = runpaths.map(({ value, owner }) =>
        path.join(expand(value, owner), reference.slice(7)),
      );
    } else {
      candidates = [expand(reference, loader)];
    }
    for (const candidate of candidates) {
      if (isSystem(candidate)) return null;
      let resolved;
      try {
        resolved = await fs.realpath(candidate);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!isWithin(root, resolved))
        throw new Error(`macOS library escapes the bundled runtime: ${reference} -> ${resolved}`);
      return resolved;
    }
    throw new Error(`Missing bundled macOS library: ${reference} required by ${loader}`);
  }

  async function visit(file, inheritedRunpaths = []) {
    const real = await fs.realpath(file);
    if (!isWithin(root, real))
      throw new Error(`macOS runtime symlink points outside the bundle: ${file}`);
    if (checked.has(real)) return;
    checked.add(real);
    const image = real === binary ? main : inspect(real);
    for (const arch of required) {
      if (!image.architectures.includes(arch))
        throw new Error(`macOS runtime architecture mismatch: ${file} does not contain ${arch}`);
    }
    const runpaths = [
      ...image.rpaths.map((value) => ({ value, owner: real })),
      ...inheritedRunpaths,
    ];
    for (const dependency of image.dependencies) {
      // otool -L prints LC_ID_DYLIB as well as actual load dependencies.
      if (image.ids.includes(dependency)) continue;
      const target = await resolveDependency(dependency, real, runpaths);
      if (target) await visit(target, runpaths);
    }
  }

  await visit(binary);
  // Validate all libraries copied to lib/, including currently unused ones.
  async function scanLibraries(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scanLibraries(file);
      else if (entry.name.endsWith('.dylib'))
        await visit(
          file,
          main.rpaths.map((value) => ({ value, owner: binary })),
        );
    }
  }
  await scanLibraries(path.join(executableDirectory, 'lib'));
  return { files: checked.size, architectures: required };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2])
    throw new Error('Usage: node make/macos/verify-runtime.mjs /path/to/ovpncli [arm64|x86_64]');
  const result = await verifyMacRuntime(process.argv[2], {
    architectures: process.argv[3] ? [process.argv[3]] : undefined,
  });
  console.log(
    `Verified macOS runtime dependencies: ${result.files} Mach-O files; ${result.architectures.join(', ')}.`,
  );
}
