import { run, npm, mvn, root, mavenArgs } from './common.mjs';
import path from 'node:path';
await run(npm, ['--prefix', 'frontend', 'test']);
await run(npm, ['--prefix', 'frontend', 'run', 'build']);
await run(mvn, [...mavenArgs, 'test'], { cwd: path.join(root, 'backend') });
