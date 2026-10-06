import { run, root } from './common.mjs';
import path from 'node:path';
await run(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], {
  env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || '1', electron_config_cache: path.join(root, '.cache', 'electron'), ELECTRON_CACHE: path.join(root, '.cache', 'electron') }
});
