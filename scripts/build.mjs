import { run, npm, mvn, root, mavenArgs } from './common.mjs';
import path from 'node:path';

await run(npm, ['--prefix', 'frontend', 'run', 'build']);
await run(mvn, [...mavenArgs, 'clean', 'package'], { cwd: path.join(root, 'backend') });
console.log('\n构建完成。npm start 启动桌面；npm run package 生成 Windows 便携版。');
