import { spawn } from 'node:child_process';
import { root, run, npm, mvn, mavenArgs } from './common.mjs';
import path from 'node:path';

await run(npm, ['--prefix', 'frontend', 'run', 'build']);
await run(mvn, [...mavenArgs, '-DskipTests', 'clean', 'package'], { cwd: path.join(root, 'backend') });
// Desktop owns backend lifecycle. Proxy's target is dynamic, so development uses
// the backend-served production bundle; run frontend's Vite separately for CSS work.
const child = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [root], { cwd: root, windowsHide: true, stdio: 'inherit', env: process.env });
child.once('exit', code => process.exit(code || 0));
