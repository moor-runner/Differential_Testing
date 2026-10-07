import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './common.mjs';

const directory = path.join(root, 'tmp', 'layouts', new Date().toISOString().replace(/[:.]/g, '-'));
const dataDir = path.join(directory, 'data'), profile = path.join(directory, 'profile');
await mkdir(dataDir, { recursive: true });
const results = [], errors = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, problem, originalLayout;
const generator = 'public class Main { public static void main(String[] args) { System.out.println(3); } }';
const brute = 'public class Main { public static void main(String[] args) { System.out.println(6); } }';
const optimized = `public class Main {
    public static void main(String[] args) {
        System.out.println(0); // 故意保留一个错误
    }
}`;
const isRunning = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function launch() {
  const env = { ...process.env, DUIPAI_DATA_DIR: dataDir, DUIPAI_USER_DATA_DIR: profile, DUIPAI_TEST_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('本地服务已连接', { exact: true }).waitFor({ timeout: 30000 });
}
async function api(url, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }, { url, method, body });
}
async function close() {
  const info = await page.evaluate(() => window.duipai.getInfo()), child = app.process();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
  for (let i = 0; i < 150 && child.exitCode === null; i++) await wait(100);
  assert.notEqual(child.exitCode, null, '窗口关闭应完成保存并退出');
  assert.equal(isRunning(info.backendPid), false, '关闭窗口后本次测试后端应退出');
  app = null;
}
async function test(name, fn) { const start = Date.now(); await fn(); results.push({ name, status: 'PASS', elapsedMs: Date.now() - start }); console.log(`PASS ${name}`); }
async function mode(name) { await page.getByRole('button', { name, exact: true }).click(); await wait(180); }
async function tab(name) { await page.getByRole('tab', { name, exact: true }).click(); await wait(180); }
async function edit(role, code) {
  await page.evaluate(({ role, code }) => window.monaco.editor.getModels().find(model => model.uri.path.endsWith(`/${role}/Main.java`)).setValue(code), { role, code });
}
async function capture(file) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(file, Buffer.from(png, 'base64'));
}
try {
  await launch();
  problem = await api('/api/problems', 'POST', { title: '数列求和 · 标签页工作空间' });
  problem.statement = '# 数列求和\n\n给定正整数 $n$，求 $1+2+\\cdots+n$。\n\n## 输入格式\n一行，一个整数 $n$。\n\n## 输出格式\n输出 $n(n+1)/2$。\n\n## 提示\n通过页签切换三份代码，再切回分栏查看对拍结果。';
  problem.codes = { generator, brute, optimized };
  problem.settings.rounds = 10; problem.settings.startSeed = '42'; problem.settings.parallelism = 1;
  await api(`/api/problems/${problem.id}`, 'PUT', problem);
  await page.reload();
  await page.locator('.code-panel .monaco-editor').nth(2).waitFor({ timeout: 30000 });
  await test('默认分栏模式保留三个编辑器、结果与可保存分隔条', async () => {
    assert.equal(await page.getByRole('button', { name: '分栏模式', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.code-panel:visible').count(), 3);
    assert.equal(await page.locator('.result-panel').isVisible(), true);
    await page.getByRole('separator', { name: /代码编辑器宽度 1/ }).focus(); await page.keyboard.press('ArrowRight');
    await page.getByRole('separator', { name: /代码与结果高度/ }).focus(); await page.keyboard.press('ArrowUp');
    await wait(650); originalLayout = await api('/api/settings/layout');
    assert.ok(originalLayout.editors[0] > 33.333); assert.ok(originalLayout.workspace[0] < 58);
    await page.evaluate(() => { window.__layoutEditors = window.monaco.editor.getEditors().filter(editor => /\/(generator|brute|optimized)\/Main\.java$/.test(editor.getModel()?.uri.path || '')); });
    const handle = page.getByRole('separator', { name: /代码编辑器宽度 1/ }), box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    assert.equal(await page.locator('body').evaluate(body => body.classList.contains('resizing')), true);
    await page.getByRole('button', { name: '标签页模式', exact: true }).focus(); await page.keyboard.press('Space'); await page.mouse.up();
    assert.equal(await page.locator('body').evaluate(body => body.classList.contains('resizing')), false, '隐藏分隔条时应清理拖动状态');
    await mode('分栏模式');
  });
  await test('标签页模式仅显示一个完整编辑器并隐藏结果及内部分隔条', async () => {
    await mode('标签页模式');
    assert.equal(await page.getByRole('button', { name: '标签页模式', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('tab').count(), 3); assert.equal(await page.locator('.code-panel:visible').count(), 1);
    assert.equal(await page.locator('.result-panel').isVisible(), false);
    assert.equal(await page.getByRole('separator', { name: /代码编辑器宽度|代码与结果高度/ }).count(), 0);
    assert.equal(await page.getByRole('separator', { name: /题面宽度/ }).isVisible(), true);
    const bounds = await page.locator('.code-panel:visible').boundingBox(), work = await page.locator('.workbench-content').boundingBox();
    assert.ok(bounds.height > work.height * 0.85, '隐藏结果后代码应占满可用高度');
    for (const [name, role] of [['生成器', 'generator'], ['暴力解', 'brute'], ['优化解', 'optimized']]) {
      await tab(name); assert.equal(await page.locator(`.code-panel.role-${role}`).isVisible(), true);
      assert.equal(await page.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true');
    }
  });
  await test('切换页签和模式保留代码、Monaco 实例、光标、滚动及撤销记录', async () => {
    const baseline = optimized + '\n' + Array.from({ length: 220 }, (_, i) => `// 第 ${i + 1} 行说明`).join('\n');
    await edit('optimized', baseline);
    await page.waitForFunction(async ({ id, baseline }) => (await fetch(`/api/problems/${id}`).then(response => response.json())).codes.optimized === baseline, { id: problem.id, baseline }, { timeout: 10000 });
    await page.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 10000 });
    await page.evaluate(() => {
      const editor = window.__layoutEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java'));
      editor.pushUndoStop(); editor.executeEdits('layout-regression', [{ range: new window.monaco.Range(1, 1, 1, 1), text: '// 标签切换保留撤销\n' }]); editor.pushUndoStop();
      editor.setPosition({ lineNumber: 85, column: 4 }); editor.setScrollTop(1500);
      window.__layoutView = { position: editor.getPosition(), scroll: editor.getScrollTop(), value: editor.getValue() };
    });
    await tab('生成器'); await tab('优化解'); await mode('分栏模式'); await mode('标签页模式');
    const state = await page.evaluate(() => {
      const editor = window.__layoutEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java'));
      const same = window.__layoutEditors.every(old => window.monaco.editor.getEditors().includes(old));
      return { same, position: editor.getPosition(), scroll: editor.getScrollTop(), value: editor.getValue(), expected: window.__layoutView, canUndo: editor.getModel().canUndo() };
    });
    assert.equal(state.same, true); assert.equal(state.canUndo, true, JSON.stringify({ valuePrefix: state.value.slice(0, 60), expectedPrefix: state.expected.value.slice(0, 60) })); assert.deepEqual(state.position, state.expected.position);
    assert.equal(state.value, state.expected.value); assert.ok(Math.abs(state.scroll - state.expected.scroll) < 2, '滚动位置应保留');
    await page.evaluate(async () => { const model = window.__layoutEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java')).getModel(); await model.undo(); });
    assert.equal(await page.evaluate(() => window.__layoutEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java')).getValue().startsWith('// 标签切换保留撤销')), false);
    await page.evaluate(async () => { const model = window.__layoutEditors.find(editor => editor.getModel().uri.path.endsWith('/optimized/Main.java')).getModel(); await model.redo(); });
    await page.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal((await api(`/api/problems/${problem.id}`)).codes.optimized, state.value);
    await edit('optimized', optimized);
  });
  await test('标签页支持方向键及 Home/End，隐藏编辑器不进入焦点顺序', async () => {
    await page.getByRole('tab', { name: '优化解', exact: true }).focus();
    await page.keyboard.press('Home'); assert.equal(await page.getByRole('tab', { name: '生成器', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowRight'); assert.equal(await page.getByRole('tab', { name: '暴力解', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End'); assert.equal(await page.getByRole('tab', { name: '优化解', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('tab', { name: '生成器', exact: true }).getAttribute('tabindex'), '-1');
  });
  await test('较慢的布局保存与快速模式切换不会覆盖最终偏好', async () => {
    await wait(650);
    let incoming = 0, release, started;
    const blocked = new Promise(resolve => { release = resolve; }), firstRequest = new Promise(resolve => { started = resolve; });
    const handler = async route => {
      if (route.request().method() === 'PUT') {
        incoming++;
        if (incoming === 1) { started(); await blocked; }
      }
      await route.continue();
    };
    await page.route('**/api/settings/layout', handler);
    try {
      await mode('分栏模式'); await firstRequest;
      await mode('标签页模式'); await tab('暴力解'); await wait(650);
      assert.equal(incoming, 1, '新布局应等旧请求完成后顺序保存');
      release();
      await page.waitForFunction(async () => { const layout = await fetch('/api/settings/layout').then(response => response.json()); return layout.uiMode?.[0] === 1 && layout.codeTab?.[0] === 1; }, null, { timeout: 10000 });
      assert.equal(incoming, 2);
      assert.equal(await page.getByRole('button', { name: '标签页模式', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByRole('tab', { name: '暴力解', exact: true }).getAttribute('aria-selected'), 'true');
    } finally { release(); await page.unroute('**/api/settings/layout', handler); }
  });
  await test('标签页内运行对拍，切回分栏恢复 WA 结果与 Diff，结果页签状态保留', async () => {
    await page.getByRole('button', { name: '开始对拍', exact: true }).click();
    await page.waitForFunction(async id => (await fetch(`/api/problems/${id}/runs`).then(response => response.json())).some(run => run.verdict === 'WA'), problem.id, { timeout: 30000 });
    assert.equal(await page.locator('.result-panel').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: '标签页模式', exact: true }).getAttribute('aria-pressed'), 'true');
    await mode('分栏模式'); await page.getByText('WA · 答案错误', { exact: true }).waitFor({ timeout: 10000 });
    await page.locator('.diff-host .monaco-diff-editor').waitFor();
    const resultHandle = page.getByRole('separator', { name: /输入与输出/ }), rect = await resultHandle.boundingBox();
    const resultRatio = await resultHandle.getAttribute('aria-valuenow');
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
    await page.getByRole('button', { name: '标签页模式', exact: true }).focus(); await page.keyboard.press('Space'); await wait(180);
    assert.equal(await page.locator('body').evaluate(body => body.classList.contains('resizing')), false, '结果区隐藏时也应清理内部拖动');
    await page.mouse.move(rect.x + 80, rect.y + rect.height / 2); await page.mouse.up(); await mode('分栏模式');
    assert.equal(await resultHandle.getAttribute('aria-valuenow'), resultRatio, '隐藏后移动指针不应改变结果比例');
    await page.getByRole('button', { name: /^历史/ }).click(); await page.locator('.history-row').first().waitFor();
    await mode('标签页模式'); await mode('分栏模式'); assert.equal(await page.locator('.history-row').first().isVisible(), true);
    const after = await api('/api/settings/layout'); assert.deepEqual(after.editors, originalLayout.editors); assert.deepEqual(after.workspace, originalLayout.workspace);
  });
  await test('标签页模式隐藏文件的编译标记正常更新，运行中可切换并停止', async () => {
    await mode('标签页模式'); await tab('生成器'); await edit('brute', 'public class Main { public static void main(String[] args) { missing; } }');
    await page.getByRole('button', { name: '开始对拍', exact: true }).click();
    await page.waitForFunction(() => window.monaco.editor.getModelMarkers({ owner: 'javac' }).some(marker => marker.resource.path.endsWith('/brute/Main.java')), null, { timeout: 30000 });
    await tab('暴力解'); await page.locator('.code-panel.role-brute').getByText(/个编译错误/).waitFor();
    await mode('分栏模式'); await page.getByText('CE · 编译错误', { exact: true }).waitFor();
    await edit('brute', brute); await edit('optimized', 'public class Main { public static void main(String[] args) { while (true) {} } }');
    await page.getByLabel('优化解时限').fill('60000'); await page.getByRole('button', { name: '开始对拍', exact: true }).click();
    await page.getByText('正在对拍', { exact: true }).waitFor({ timeout: 30000 });
    await mode('标签页模式'); await tab('优化解'); assert.equal(await page.locator('.result-panel').isVisible(), false);
    await page.getByRole('button', { name: '停止', exact: true }).click(); await mode('分栏模式');
    await page.getByText('CANCELLED · 已停止', { exact: true }).waitFor({ timeout: 15000 });
    await edit('optimized', optimized); await page.getByLabel('优化解时限').fill('2000');
  });
  await test('标签页模式换题保存旧代码，释放旧模型并正确加载新题', async () => {
    await mode('标签页模式'); await tab('优化解');
    const changed = optimized + '\n// 换题前的待保存内容'; await edit('optimized', changed);
    await page.getByRole('button', { name: '新建题目', exact: true }).click();
    await page.getByLabel('题目标题').fill('标签页换题验证'); await page.getByRole('button', { name: '创建题目', exact: true }).click();
    await page.getByRole('heading', { name: '标签页换题验证', exact: true }).waitFor();
    await page.locator('.role-optimized .monaco-editor').waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('tab', { name: '优化解', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.code-panel:visible').count(), 1);
    assert.equal((await api(`/api/problems/${problem.id}`)).codes.optimized, changed);
    const models = await page.evaluate(() => window.monaco.editor.getModels().filter(model => /\/(generator|brute|optimized)\/Main\.java$/.test(model.uri.path)).map(model => model.uri.path));
    assert.equal(models.length, 3); assert.equal(models.some(uri => uri.includes(problem.id)), false);
    await page.getByRole('button', { name: new RegExp(problem.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
    await page.getByRole('heading', { name: problem.title, exact: true }).waitFor();
    await page.waitForFunction(id => window.monaco.editor.getModels().some(model => model.uri.path.includes(id) && model.getValue().includes('换题前的待保存内容')), problem.id);
    await edit('optimized', optimized); await page.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 10000 });
  });
  await test('最小窗口显示完整，关闭前保存并在重启后恢复模式、页签和分栏尺寸', async () => {
    await mode('标签页模式'); await tab('优化解');
    await capture(path.join(root, 'docs', 'tabbed-workbench.png'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700)); await wait(200);
    for (const name of ['分栏模式', '标签页模式']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, '最小窗口内显示切换按钮');
    }
    await mode('分栏模式'); assert.equal(await page.locator('.code-panel:visible').count(), 3);
    await mode('标签页模式'); await tab('暴力解');
    // Close within the preference debounce interval to exercise the close flush.
    await close(); await launch();
    await page.getByRole('heading', { name: problem.title, exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByRole('button', { name: '标签页模式', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('tab', { name: '暴力解', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.code-panel:visible').count(), 1); assert.equal(await page.locator('.result-panel').isVisible(), false);
    const persisted = await api('/api/settings/layout'); assert.deepEqual(persisted.editors, originalLayout.editors); assert.deepEqual(persisted.workspace, originalLayout.workspace);
    assert.equal((await api(`/api/problems/${problem.id}`)).codes.optimized, optimized);
    await mode('分栏模式'); await page.locator('.role-brute .monaco-editor').waitFor();
    assert.equal(await page.locator('.code-panel:visible').count(), 3); assert.deepEqual(errors, []);
  });
  await close();
  await writeFile(path.join(root, 'docs', 'layout-results.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length} 项显示模式验收通过。`);
} catch (error) {
  if (page && !page.isClosed()) await capture(path.join(root, 'tmp', 'layout-failure.png')).catch(() => {});
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
