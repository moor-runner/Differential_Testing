import { run, root } from './common.mjs';
import path from 'node:path';
if (!process.argv.includes('--skip-build')) await run(process.execPath, [path.join(root, 'scripts', 'build.mjs')]);
await run(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', process.argv.includes('--dir') ? 'dir' : 'portable', '--x64'], {
  env: { ...process.env, ELECTRON_CACHE: path.join(root, '.cache', 'electron'), ELECTRON_BUILDER_CACHE: path.join(root, '.cache', 'electron-builder') }
});
