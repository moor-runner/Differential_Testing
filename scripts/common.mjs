import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
export const mvn = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
export const backendBuildDirectory = path.join(root, '.cache', 'backend-build');
export const backendJar = path.join(backendBuildDirectory, 'duipai-backend.jar');
export const mavenArgs = [`-Dmaven.repo.local=${path.join(root, '.cache', 'm2')}`, `-Dduipai.build.directory=${backendBuildDirectory}`];
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' && command.endsWith('.cmd'), ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
