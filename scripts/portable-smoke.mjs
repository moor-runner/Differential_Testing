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
  assert.equal(path.resolve(info.logPath), path.resolve(directory, 'data', 'backend.log'));
  assert.ok((await stat(info.logPath)).isFile());
  assert.equal(await page.evaluate(() => typeof window.duipai.openBackendLog), 'function');
  await page.getByRole('button', { name: '查看后台日志', exact: true }).waitFor();
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
  // Exercise the bundled PowerShell resource as well as the recognition UI in the delivered EXE.
  const recognitionStatus = await api('/api/images/recognition/status');
  assert.equal(typeof recognitionStatus.available, 'boolean');
  let recognitionVerified = false;
  if (recognitionStatus.available) {
    await page.locator('.statement-footer input[type="file"]').setInputFiles(path.join(root, 'backend', 'src', 'test', 'resources', 'ocr', 'canvas-sample-rows.png'));
    const source = page.getByRole('button', { name: '查看图片：canvas-sample-rows.png', exact: true });
    await source.waitFor({ timeout: 15000 });
    const imageUrl = await source.locator('img').getAttribute('src');
    assert.ok(imageUrl?.startsWith('/api/images/'));
    const recognized = await api(`${imageUrl}/recognize`, 'POST', {});
    assert.ok(recognized.lines.some(line => /^1\s+2\s+3$/.test(line.text.trim())), 'Bundled OCR must retain the numeric sample row');
    await page.getByRole('button', { name: '识别图片题目', exact: true }).click();
    const recognition = page.getByRole('dialog', { name: '识别图片题目', exact: true });
    await recognition.waitFor();
    await recognition.getByRole('button', { name: '开始识别', exact: true }).waitFor();
    await recognition.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '整理题面', exact: true }).click();
    await recognition.getByLabel('测试样例', { exact: true }).waitFor({timeout: 30000});
    assert.match(await recognition.getByLabel('测试样例', {exact: true}).inputValue(), /1\s*2\s*3/);
    await recognition.getByRole('button', {name: '取消', exact: true}).click();
    recognitionVerified = true;
  }
  // Check the AI UI and local key storage in the delivered bundle without any provider request.
  const aiBefore = await api('/api/settings/ai');
  assert.deepEqual(aiBefore, { baseUrl: 'https://api.openai.com/v1', model: '', apiKeyConfigured: false });
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
  const aiSettings = page.getByRole('dialog', { name: 'AI 设置', exact: true });
  await aiSettings.getByLabel('模型名称', { exact: true }).fill('portable-test-model');
  const fakeAiKey = 'sk-fake-portable-ai-local-storage-only';
  await aiSettings.getByLabel('API Key', { exact: true }).fill(fakeAiKey);
  await aiSettings.getByRole('button', { name: '保存配置', exact: true }).click();
  await aiSettings.getByText('AI 配置已保存。', { exact: true }).waitFor();
  assert.equal(await aiSettings.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal((await api('/api/settings/ai')).apiKeyConfigured, true);
  const aiStorage = await readFile(path.join(directory, 'data', 'ai-settings.json'), 'utf8');
  assert.ok(!aiStorage.includes(fakeAiKey)); assert.match(JSON.parse(aiStorage).encryptedApiKey, /^dpapi:v1:/);
  await aiSettings.getByRole('checkbox', { name: '清除已保存的 API Key', exact: true }).check();
  await aiSettings.getByRole('button', { name: '保存配置', exact: true }).click();
  await aiSettings.getByText('尚未保存 Key。', { exact: false }).waitFor();
  assert.equal((await api('/api/settings/ai')).apiKeyConfigured, false);
  await aiSettings.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: 'AI 整理题面', exact: true }).click();
  const aiOrganizer = page.getByRole('dialog', { name: 'AI 整理题面', exact: true });
  await aiOrganizer.getByLabel('发送给 AI 的题面文字', { exact: true }).waitFor();
  assert.doesNotMatch(await aiOrganizer.getByLabel('发送给 AI 的题面文字', { exact: true }).inputValue(), /\/api\/images\//);
  assert.ok(!await aiOrganizer.getByRole('button', { name: '应用到题面', exact: true }).isEnabled());
  await aiOrganizer.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '标签页模式', exact: true }).click();
  await page.getByRole('tab', { name: '优化解', exact: true }).click();
  assert.equal(await page.locator('.code-panel:visible').count(), 1);
  assert.equal(await page.locator('.result-panel').isVisible(), false);
  await wait(650); await page.reload();
  await page.getByRole('tab', { name: '优化解', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByRole('button', { name: '标签页模式', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('tab', { name: '优化解', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.code-panel:visible').count(), 1);
  await page.getByRole('button', { name: '分栏模式', exact: true }).click();
  assert.equal(await page.locator('.code-panel:visible').count(), 3);
  assert.equal(await page.locator('.result-panel').isVisible(), true);
  await page.getByRole('button', { name: '全屏模式', exact: true }).click();
  await page.waitForFunction(async () => document.querySelector('.app-shell').classList.contains('is-fullscreen') && await window.duipai.isFullscreen());
  for (const selector of ['.app-header', '.toolbar', '.sidebar', '.result-panel', '.statusbar', '.statement-footer']) assert.equal(await page.locator(`${selector}:visible`).count(), 0);
  assert.equal(await page.locator('.code-panel:visible').count(), 3);
  assert.equal(await page.locator('.markdown').evaluate(element => getComputedStyle(element).fontSize), '16px');
  assert.deepEqual(await page.evaluate(() => window.monaco.editor.getEditors().filter(editor => /\/(generator|brute|optimized)\/Main\.java$/.test(editor.getModel()?.uri.path || '')).map(editor => editor.getOption(window.monaco.editor.EditorOption.fontSize))), [16, 16, 16]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(async () => !document.querySelector('.app-shell').classList.contains('is-fullscreen') && !await window.duipai.isFullscreen());
  assert.equal(await page.locator('.markdown').evaluate(element => getComputedStyle(element).fontSize), '12px');
  assert.equal(await page.locator('.result-panel').isVisible(), true);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.close()).catch(() => {});
  for (let i = 0; i < 200 && (isRunning(backendPid) || child.exitCode === null); i++) await wait(100);
  assert.equal(isRunning(backendPid), false, 'Packaged backend should close with its window');
  assert.equal(child.exitCode, 0, 'Portable launcher should exit normally');
  const result = { date: new Date().toISOString(), executable: path.basename(executable), status: 'PASS', checks: ['实际便携 EXE 解压与启动', '本地 Monaco、图片插入及预览尺寸适配', '真实 JDK 21 三轮对拍及历史保存', '分栏/标签页切换、隐藏结果及偏好恢复', '原生全屏、隐藏辅助界面、放大字体与 Esc 恢复', ...(recognitionVerified ? ['打包后的本地 OCR、样例数字补识别、映射及自动整理入口'] : []), '打包后的 AI 整理入口、Key 配置加密及清除、后台日志路径与入口', '正常关闭与后端退出'], elapsedMs: Date.now() - startedAt };
  await writeFile(path.join(root, 'docs', 'portable-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
