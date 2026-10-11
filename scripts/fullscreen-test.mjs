import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root, electronExecutable, waitForApp, waitForAsync } from './common.mjs';

const directory = path.join(root, 'tmp', 'fullscreen', new Date().toISOString().replace(/[:.]/g, '-'));
const dataDir = path.join(directory, 'data'), profile = path.join(directory, 'profile');
const temporary = path.join(directory, 'temp');
await mkdir(dataDir, { recursive: true }); await mkdir(temporary, { recursive: true });
process.env.TEMP = temporary; process.env.TMP = temporary;
const results = [], errors = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, problem, originalLayout;
const code = 'public class Main { public static void main(String[] args) { System.out.println(6); } }';
const optimized = code + '\n' + Array.from({ length: 160 }, (_, index) => `// 第 ${index + 1} 行说明`).join('\n');
// Since 5d8e5a6 fullscreen hides the top bar, problem list, run settings and results; the editor footers (check state, tools) stay.
const chrome = ['.topbar', '.sidebar', '.run-config', '.result-panel'];
const isRunning = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function launch() {
  const env = { ...process.env, DUIPAI_DATA_DIR: dataDir, DUIPAI_USER_DATA_DIR: profile, DUIPAI_TEST_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: electronExecutable, args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', error => errors.push(error.message));
  await waitForApp(page);
}
async function api(url, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }, { url, method, body });
}
async function test(name, callback) {
  const started = Date.now(); await callback();
  results.push({ name, status: 'PASS', elapsedMs: Date.now() - started }); console.log(`PASS ${name}`);
}
let nativeFullscreen = false;
async function fullscreen(expected) {
  await waitForAsync(page, async expected => document.querySelector('.app-shell').classList.contains('is-fullscreen') === expected && await window.duipai.isFullscreen() === expected, expected, { timeout: 10000 });
  // macOS animates native fullscreen and drops a toggle requested mid-animation; wait for the window's own enter/leave event.
  if (process.platform === 'darwin' && expected !== nativeFullscreen)
    await page.waitForFunction(expected => !window.__fullscreenEvents || window.__fullscreenEvents.at(-1)?.value === expected, expected, { timeout: 10000 });
  nativeFullscreen = expected;
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), expected, '原生窗口与页面全屏状态一致');
  await wait(180);
}
// Fullscreen is an item in the "更多" menu; the layout follows the view (对拍 = three editors, 编辑 = tabs).
async function enterFullscreen() {
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '全屏模式', exact: true }).click();
}
async function capture(file) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(file, Buffer.from(png, 'base64'));
}
async function savedCode(value) {
  await waitForAsync(page, async ({ id, value }) => (await fetch(`/api/problems/${id}`).then(response => response.json())).codes.optimized === value, { id: problem.id, value }, { timeout: 10000 });
}
async function assertHiddenChrome() {
  for (const selector of chrome) assert.equal(await page.locator(`${selector}:visible`).count(), 0, `${selector} 应隐藏`);
  assert.equal(await page.getByRole('separator', { name: /题目列表宽度|代码与结果高度/ }).count(), 0, '隐藏区域的分隔条不进入焦点顺序');
}
async function close() {
  const info = await page.evaluate(() => window.duipai.getInfo()), child = app.process();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
  for (let index = 0; index < 150 && child.exitCode === null; index++) await wait(100);
  assert.notEqual(child.exitCode, null, '关闭窗口应完成保存并退出');
  assert.equal(isRunning(info.backendPid), false, '关闭窗口后测试后端应退出'); app = null;
}

try {
  await launch();
  await test('没有题目时全屏入口禁用，F11 保留欢迎页', async () => {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: '全屏模式', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('F11'); await fullscreen(false);
  });
  problem = await api('/api/problems', 'POST', { title: '数列求和 · 全屏工作空间' });
  problem.statement = '# 数列求和\n\n给定正整数 $n$，求 $1+2+\\cdots+n$。\n\n## 输入格式\n一行，一个整数 $n$。\n\n## 输出格式\n输出 $n(n+1)/2$。';
  problem.codes = { generator: code, brute: code, optimized };
  await api(`/api/problems/${problem.id}`, 'PUT', problem); await page.reload();
  await page.locator('.role-optimized .monaco-editor').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '对拍界面', exact: true }).click();
  await page.evaluate(() => {
    window.__fullscreenEditors = window.monaco.editor.getEditors().filter(editor => /\/(generator|brute|optimized)\/Main\.java$/.test(editor.getModel()?.uri.path || ''));
    window.__fullscreenEvents = [];
    window.duipai.onFullscreenChange(async value => window.__fullscreenEvents.push({ value, native: await window.duipai.isFullscreen(), time: performance.now() }));
  });
  await page.getByRole('separator', { name: /代码编辑器宽度 1/ }).focus(); await page.keyboard.press('ArrowRight');
  await page.getByRole('separator', { name: /代码与结果高度/ }).focus(); await page.keyboard.press('ArrowUp');
  await wait(650); originalLayout = await api('/api/settings/layout');

  await test('对拍界面全屏仅保留题面和三个编辑器，原生全屏且字体放大', async () => {
    // Default reading size is 14px (displayPreferences fontSizeRange.initial); fullscreen adds 2.
    assert.equal(await page.locator('.markdown').evaluate(element => getComputedStyle(element).fontSize), '14px');
    await enterFullscreen(); await fullscreen(true);
    await assertHiddenChrome(); assert.equal(await page.locator('.code-panel:visible').count(), 3);
    assert.equal(await page.getByRole('button', { name: '退出全屏', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.statement-panel .panel-heading').getByText(problem.title, { exact: true }).isVisible(), true);
    assert.equal(await page.locator('.markdown').evaluate(element => getComputedStyle(element).fontSize), '16px');
    const sizes = await page.evaluate(() => window.__fullscreenEditors.map(editor => editor.getOption(window.monaco.editor.EditorOption.fontSize)));
    assert.deepEqual(sizes, [16, 16, 16]);
    const work = await page.locator('.main-workspace').boundingBox(), editor = await page.locator('.code-panel.role-optimized').boundingBox();
    assert.ok(editor.height > work.height * 0.95, '编辑器占满全屏工作区高度');
    await capture(path.join(root, 'docs', 'fullscreen-workbench.png'));
  });
  await test('全屏题面编辑字体放大，自动保存与 Ctrl+S 正常', async () => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const textarea = page.getByLabel('Markdown 题面', { exact: true });
    assert.equal(await textarea.evaluate(element => getComputedStyle(element).fontSize), '16px');
    const statement = problem.statement + '\n\n全屏下补充的说明。'; await textarea.fill(statement);
    await waitForAsync(page, async ({ id, statement }) => (await fetch(`/api/problems/${id}`).then(response => response.json())).statement === statement, { id: problem.id, statement }, { timeout: 10000 });
    await textarea.fill(statement + '\n手动保存。'); await page.keyboard.press('ControlOrMeta+s');
    await waitForAsync(page, async ({ id, statement }) => (await fetch(`/api/problems/${id}`).then(response => response.json())).statement === statement, { id: problem.id, statement: statement + '\n手动保存。' }, { timeout: 10000 });
    await page.getByRole('button', { name: '预览', exact: true }).click();
  });
  await test('进入退出全屏保留 Monaco 实例、代码、光标及撤销记录，恢复分栏尺寸', async () => {
    await page.evaluate(() => {
      const editor = window.__fullscreenEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java'));
      editor.pushUndoStop(); editor.executeEdits('fullscreen-regression', [{ range: new window.monaco.Range(1, 1, 1, 1), text: '// 全屏撤销验收\n' }]); editor.pushUndoStop();
      editor.setPosition({ lineNumber: 70, column: 4 }); editor.setScrollTop(1400);
      window.__fullscreenView = { position: editor.getPosition(), value: editor.getValue() };
      editor.focus();
    });
    await page.keyboard.press('ControlOrMeta+s'); await savedCode(await page.evaluate(() => window.__fullscreenView.value));
    await page.getByRole('button', { name: '退出全屏', exact: true }).click(); await fullscreen(false);
    await enterFullscreen(); await fullscreen(true);
    await page.keyboard.press('Escape'); await fullscreen(false);
    const state = await page.evaluate(() => {
      const editor = window.__fullscreenEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java'));
      return { same: window.__fullscreenEditors.every(old => window.monaco.editor.getEditors().includes(old)), position: editor.getPosition(), value: editor.getValue(), expected: window.__fullscreenView, canUndo: editor.getModel().canUndo(), fonts: window.__fullscreenEditors.map(editor => editor.getOption(window.monaco.editor.EditorOption.fontSize)) };
    });
    assert.equal(state.same, true); assert.equal(state.canUndo, true); assert.deepEqual(state.position, state.expected.position); assert.equal(state.value, state.expected.value); assert.deepEqual(state.fonts, [14, 14, 14]);
    assert.equal(await page.locator('.markdown').evaluate(element => getComputedStyle(element).fontSize), '14px');
    assert.equal(await page.locator('.code-panel:visible').count(), 3); assert.equal(await page.locator('.result-panel').isVisible(), true);
    const restored = await api('/api/settings/layout');
    for (const key of ['sidebar', 'statement', 'workspace', 'editors']) assert.deepEqual(restored[key], originalLayout[key], `${key} 分栏比例应保留`);
    await savedCode(state.value);
    await page.evaluate(async () => { await window.__fullscreenEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java')).getModel().undo(); });
    await savedCode(optimized);
  });
  await test('编辑界面（标签页）全屏保持活动编辑器，Monaco 内 F11 与 Esc 可退出并恢复布局', async () => {
    await page.getByRole('button', { name: '编辑界面', exact: true }).click();
    await page.getByRole('tab', { name: '优化解', exact: true }).click();
    await page.evaluate(() => window.__fullscreenEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java')).focus());
    await page.keyboard.press('F11'); await fullscreen(true); await assertHiddenChrome();
    assert.equal(await page.locator('.code-panel:visible').count(), 1); assert.equal(await page.getByRole('tab', { name: '优化解', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: '暴力解', exact: true }).click();
    assert.equal(await page.locator('.code-panel.role-brute').isVisible(), true);
    await page.keyboard.press('Escape'); await fullscreen(false);
    assert.equal(await page.getByRole('button', { name: '编辑界面', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('tab', { name: '暴力解', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.code-panel:visible').count(), 1);
    await page.keyboard.press('F11'); await fullscreen(true); await page.keyboard.press('F11'); await fullscreen(false);
  });
  await test('原生窗口全屏变化同步页面，最小窗口入口和退出控件完整显示', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true)); await fullscreen(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(false)); await fullscreen(false);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700)); await wait(180);
    const sizedState = await page.evaluate(async () => ({ native: await window.duipai.isFullscreen(), rendered: document.querySelector('.app-shell').classList.contains('is-fullscreen') }));
    assert.deepEqual(sizedState, { native: false, rendered: false }, '调整普通窗口大小后仍保持非全屏');
    const entry = await page.getByRole('button', { name: '更多', exact: true }).boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(entry.x >= 0 && entry.x + entry.width <= viewport.width && entry.y + entry.height <= viewport.height, '最小窗口内显示全屏入口');
    await page.getByRole('button', { name: '对拍界面', exact: true }).click();
    // The problem list is collapsed by default; its width handle exists only while it is shown.
    await page.getByRole('button', { name: '题目列表', exact: true }).click();
    const handle = page.getByRole('separator', { name: /题目列表宽度/ }), bounds = await handle.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    assert.equal(await page.locator('body').evaluate(element => element.classList.contains('resizing')), true);
    await page.keyboard.press('F11'); await fullscreen(true); await page.mouse.up();
    assert.equal(await page.locator('body').evaluate(element => element.classList.contains('resizing')), false, '进入全屏时清理隐藏分隔条的拖动');
    const exit = await page.getByRole('button', { name: '退出全屏', exact: true }).boundingBox(), fullViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(exit.x >= 0 && exit.x + exit.width <= fullViewport.width && exit.y + exit.height <= fullViewport.height, '全屏内显示退出控件');
    await page.keyboard.press('Escape'); await fullscreen(false); assert.deepEqual(errors, []);
  });
  await close();
  await writeFile(path.join(root, 'docs', 'fullscreen-results.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length} 项全屏模式验收通过。`);
} catch (error) {
  if (page && !page.isClosed()) {
    await capture(path.join(directory, 'failure.png')).catch(() => {});
    const state = await page.evaluate(async () => ({ native: await window.duipai.isFullscreen(), rendered: document.querySelector('.app-shell').classList.contains('is-fullscreen'), events: window.__fullscreenEvents, viewport: { width: innerWidth, height: innerHeight } })).catch(() => null);
    await writeFile(path.join(directory, 'failure.json'), JSON.stringify({ error: error.message, state, results }, null, 2)).catch(() => {});
  }
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
