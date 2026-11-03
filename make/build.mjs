#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertBuildRoot } from './lib/paths.mjs';
import {
  assertBuildHost,
  buildPackage,
  collectArtifacts,
  detectPlatform,
  loadUpstream,
  parseOptions,
  prepareLocalSource,
  prepareSource,
  readBranding,
  readLogPrivacy,
  readProfile,
  withBuildLock,
} from './lib/build.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `Usage: node build.mjs [options]

  --platform windows|macos|auto  Build platform (default: detect current OS)
  --profile PATH               Private profile (default: custom-config/client.ovpn)
  --prepare-only               Copy current source and replace profile, without compiling
  --force-engine               Force a clean native engine rebuild using cached source
  --skip-engine                Reuse an engine verified by the upstream scripts
  --no-auto-install-deps       Use existing tools without automatic installation
  -h, --help                   Show this help

The installer selects the OS, prepares dependencies, copies the current source
into an isolated build cache, reuses verified engine/dependency/compiler caches,
replaces the private profile, and builds an
installer. Node.js 22+ is required.
Windows packages must be built on Windows; macOS packages on macOS.
Relative --profile paths are resolved from the current working directory.
Source: .cache/work/<platform>/source; installers: build_dist/<platform>/ — each build
replaces the previous installers there; no installer copy is left in the cache.`;

export async function runBuild(
  args = [],
  { root = projectRoot, prepareEnvironment, localSource = false } = {},
) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(help);
    return;
  }
  assertBuildRoot(root);
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Node.js 22 or newer is required.');
  }
  const platform = detectPlatform(options.platform);
  if (!options.prepareOnly) assertBuildHost(platform);
  console.log(`Detected build environment: ${platform} (${process.arch})`);
  const upstream = localSource
    ? { repository: 'local-working-tree', commit: 'working-tree' }
    : await loadUpstream(root);
  const profile = await readProfile(
    path.resolve(options.profile ?? path.join(root, 'custom-config/client.ovpn')),
  );
  const branding = localSource
    ? await readBranding(path.join(root, 'custom-config/app-branding.json'))
    : null;
  const logPrivacy = localSource
    ? await readLogPrivacy(path.join(root, 'custom-config/log-privacy.json'))
    : null;
  await withBuildLock(root, platform, async () => {
    // Validate the private input before installing tools or downloading source.
    if (prepareEnvironment && !options.prepareOnly && !options.noAutoInstallDeps) {
      console.log('[1/3] Checking and installing build dependencies...');
      await prepareEnvironment({ root, platform });
    }
    console.log('[2/3] Preparing source and private profile...');
    const prepared = localSource
      ? await prepareLocalSource({ root, platform, upstream, profile, branding, logPrivacy })
      : await prepareSource({ root, platform, upstream, profile });
    console.log(
      `Source ready: ${prepared.sourceDir}\nSource revision: ${upstream.commit}\nPrivate profile replaced: resources/settings/client.ovpn`,
    );
    if (options.prepareOnly) {
      console.log('Preparation completed. No compiler or packaging tools were invoked.');
      return;
    }
    console.log('[3/3] Compiling and packaging the client...');
    await buildPackage(prepared, options);
    const { outputDir } = await collectArtifacts({ root, prepared });
    console.log(`Build completed. Private installers and build-info.json: ${outputDir}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runBuild(process.argv.slice(2), { localSource: true }).catch((error) => {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
