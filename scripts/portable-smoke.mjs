import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root } from './common.mjs';

const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const executable = path.join(root, 'release', `Duipai-${version}-win-x64.exe`);
const directory = path.join(root, 'tmp', 'portable', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const isRunning = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const env = { ...process.env, DUIPAI_TEST_HIDDEN: '1', DUIPAI_DATA_DIR: path.join(directory, 'data'), DUIPAI_USER_DATA_DIR: path.join(directory, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
assert.ok((await stat(executable)).size > 50 * 1024 * 1024);
const startedAt = Date.now();
const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
let browser, backendPid;
try {
  let endpoint;
  for (let i = 0; i < 600; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { endpoint = (await response.json()).webSocketDebuggerUrl; break; }
    } catch { /* portable extraction and backend startup are still in progress */ }
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`Portable launcher exited ${child.exitCode}`);
    await wait(100);
  }
  assert.ok(endpoint, 'Actual portable executable must launch its Chromium window');
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  let page;
  for (let i = 0; i < 300; i++) {
    page = context.pages().find(value => value.url().startsWith('http://127.0.0.1:'));
    if (page) break;
    await wait(100);
  }
  assert.ok(page, 'Packaged window should load the local backend');
  await page.getByText('本地服务已连接', { exact: true }).waitFor({ timeout: 30000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const info = await page.evaluate(() => window.duipai.getInfo());
  backendPid = info.backendPid;
  assert.equal(info.version, version); assert.match(info.javaVersion, /^21/);
  assert.equal(path.resolve(info.dataDir), path.resolve(directory, 'data'));
  async function api(url, method = 'GET', body) {
    return page.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json();
    }, { url, method, body });
  }
  const problem = await api('/api/problems', 'POST', { title: '便携程序启动验收' });
  problem.settings.rounds = 3; problem.settings.parallelism = 2; problem.settings.startSeed = '100';
  await api(`/api/problems/${problem.id}`, 'PUT', problem);
  await page.reload();
  await page.locator('.code-panel .monaco-editor').nth(2).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '开始对拍', exact: true }).click();
  await page.getByText('PASS · 全部通过', { exact: true }).waitFor({ timeout: 30000 });
  const history = await api(`/api/problems/${problem.id}/runs`);
  assert.equal(history[0].completed, 3); assert.equal(history[0].verdict, 'PASS');
  // Verify the delivered bundle contains the actual image fix, too.
  await page.locator('.statement-footer input[type="file"]').setInputFiles(path.join(root, 'docs', 'image-preview.png'));
  const thumbnail = page.getByRole('button', { name: '查看图片：image-preview.png', exact: true });
  await thumbnail.waitFor({ timeout: 15000 }); await thumbnail.locator('img').evaluate(image => image.decode()); await thumbnail.click();
  await page.getByRole('dialog', { name: '图片预览', exact: true }).waitFor();
  assert.ok(await page.locator('.image-viewer').evaluate(dialog => { const bounds = dialog.getBoundingClientRect(); return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1; }));
  await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.close()).catch(() => {});
  for (let i = 0; i < 200 && (isRunning(backendPid) || child.exitCode === null); i++) await wait(100);
  assert.equal(isRunning(backendPid), false, 'Packaged backend should close with its window');
  assert.equal(child.exitCode, 0, 'Portable launcher should exit normally');
  const result = { date: new Date().toISOString(), executable: path.basename(executable), status: 'PASS', checks: ['实际便携 EXE 解压与启动', '本地 Monaco、图片插入及预览尺寸适配', '真实 JDK 21 三轮对拍及历史保存', '正常关闭与后端退出'], elapsedMs: Date.now() - startedAt };
  await writeFile(path.join(root, 'docs', 'portable-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
