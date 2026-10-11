import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
export const mvn = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
export const backendBuildDirectory = path.join(root, '.cache', 'backend-build');
export const backendJar = path.join(backendBuildDirectory, 'duipai-backend.jar');
/** Electron's binary as installed in node_modules for this platform. */
export const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
/**
 * The app has finished booting: problems and layout are loaded and the UI can be used. App.tsx publishes
 * this as data-boot on its root, independent of any visible wording; a boot error fails at once with its reason.
 */
export async function waitForApp(page, timeout = 30000) {
  const state = await page.locator('.app-shell[data-boot="ready"], .app-shell[data-boot="error"]').first().getAttribute('data-boot', { timeout });
  if (state === 'error') throw new Error(`应用启动失败：${(await page.locator('.error-state p').textContent().catch(() => '')) || '未知原因'}`);
}
/** Statement tools (insert image, recognize, organize, AI) live in the statement panel's "题面工具" menu. */
export async function statementTool(page, name) {
  await page.getByRole('button', { name: '题面工具', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
/** The save indicator is a dot; its accessible name carries the state. */
export async function waitForSaved(page, timeout = 10000) {
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor({ timeout });
}
/**
 * Playwright's waitForFunction calls the predicate synchronously and accepts any truthy value, so an async
 * predicate's Promise ends the wait after one check whatever it resolves to. This polls until it is truthy.
 */
export async function waitForAsync(page, predicate, arg, { timeout = 10000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(predicate, arg);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待条件超时（${timeout}ms）：${predicate.toString().slice(0, 200)}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
export const mavenArgs = [`-Dmaven.repo.local=${path.join(root, '.cache', 'm2')}`, `-Dduipai.build.directory=${backendBuildDirectory}`];
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' && command.endsWith('.cmd'), ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
