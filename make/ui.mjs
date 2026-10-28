import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildEnvironment, projectRoot } from './lib/paths.mjs';

const [command = 'dev', ...args] = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    path.join(projectRoot, 'node_modules/vite/bin/vite.js'),
    command,
    '--config',
    path.join(projectRoot, 'ui/vite.config.ts'),
    ...args,
  ],
  {
    cwd: projectRoot,
    env: buildEnvironment(),
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
