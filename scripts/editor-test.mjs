import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './common.mjs';

const directory = path.join(root, 'tmp', 'editor', new Date().toISOString().replace(/[:.]/g, '-'));
const dataDir = path.join(directory, 'data'), profile = path.join(directory, 'profile');
const temporary = path.join(directory, 'temp');
await mkdir(dataDir, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(path.join(root, 'docs'), { recursive: true });
process.env.TEMP = temporary; process.env.TMP = temporary;

const roleLabels = { generator: '生成器', brute: '暴力解', optimized: '优化解' };
const roles = Object.keys(roleLabels);
const validCode = `public class Main {
    public static void main(String[] args) {
        System.out.println(7);
    }
}`;
const results = [], external = [], errors = [], analysisResponses = [], analysisFailures = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, problem;

async function launch() {
  const env = { ...process.env, DUIPAI_DATA_DIR: dataDir, DUIPAI_USER_DATA_DIR: profile, DUIPAI_TEST_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    if (!response.url().endsWith('/api/editor/java/analyze')) return;
    analysisResponses.push({ operation: response.request().postDataJSON()?.operation, status: response.status(), body: (await response.text().catch(() => '(cancelled response)')).slice(0, 2000) });
  });
  page.on('requestfailed', request => {
    if (request.url().endsWith('/api/editor/java/analyze')) analysisFailures.push({ operation: request.postDataJSON()?.operation, error: request.failure()?.errorText });
  });
  page.on('request', request => {
    if (!/^https?:/.test(request.url())) return;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.getByText('本地服务已连接', { exact: true }).waitFor({ timeout: 30000 });
  problem = await api('/api/problems', 'POST', { title: 'Java 编辑器 · IDEA 风格验收' });
  problem.statement = '# Java 编辑器验收\n\n本地补全、实时检查、导航和编辑快捷键。';
  problem.codes = Object.fromEntries(roles.map(role => [role, validCode]));
  await api(`/api/problems/${problem.id}`, 'PUT', problem);
  await page.reload();
  await page.locator('.role-optimized .monaco-editor').waitFor({ timeout: 30000 });
  await page.evaluate(() => {
    window.__editorAcceptanceEditors = Object.fromEntries(['generator', 'brute', 'optimized'].map(role => [role,
      window.monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path.endsWith(`/${role}/Main.java`))]));
    if (Object.values(window.__editorAcceptanceEditors).some(editor => !editor)) throw new Error('三个独立 Java 编辑器必须全部挂载');
  });
}
async function api(url, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }, { url, method, body });
}
async function test(name, callback) {
  const started = Date.now();
  await callback();
  results.push({ name, status: 'PASS', elapsedMs: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function setCode(role, source, cursorText, cursorDelta = 0) {
  await page.keyboard.press('Escape');
  await page.evaluate(({ role, source, cursorText, cursorDelta }) => {
    const editor = window.__editorAcceptanceEditors[role], model = editor.getModel();
    model.setValue(source);
    let offset = cursorText ? source.lastIndexOf(cursorText) + cursorText.length + cursorDelta : 0;
    if (cursorText && source.lastIndexOf(cursorText) < 0) throw new Error(`找不到光标文本 ${cursorText}`);
    editor.setPosition(model.getPositionAt(offset)); editor.revealPositionInCenter(editor.getPosition()); editor.focus();
  }, { role, source, cursorText, cursorDelta });
}
async function value(role = 'optimized') {
  return page.evaluate(role => window.__editorAcceptanceEditors[role].getValue(), role);
}
async function expectValue(role, source) {
  await page.waitForFunction(({ role, source }) => window.__editorAcceptanceEditors[role].getValue() === source, { role, source }, { timeout: 10000 });
}
async function expectClean(role, source) {
  await page.waitForFunction(({ role, source }) => {
    const editor = window.__editorAcceptanceEditors[role], model = editor.getModel();
    return model.getValue() === source
      && !window.monaco.editor.getModelMarkers({ owner: 'java-live', resource: model.uri }).length
      && document.querySelector(`.role-${role} .editor-footer`)?.textContent.includes('Java 检查通过');
  }, { role, source }, { timeout: 30000 });
}
async function markers(role) {
  return page.evaluate(role => {
    const model = window.__editorAcceptanceEditors[role].getModel();
    return window.monaco.editor.getModelMarkers({ owner: 'java-live', resource: model.uri }).map(marker => ({
      message: marker.message, line: marker.startLineNumber, column: marker.startColumn,
      severity: marker.severity, path: marker.resource.path,
    }));
  }, role);
}
async function expectErrors(role) {
  await page.waitForFunction(role => {
    const model = window.__editorAcceptanceEditors[role].getModel();
    return window.monaco.editor.getModelMarkers({ owner: 'java-live', resource: model.uri }).some(marker => marker.severity === window.monaco.MarkerSeverity.Error);
  }, role, { timeout: 30000 });
  const diagnostics = await markers(role);
  assert.ok(diagnostics.every(marker => marker.line > 0 && marker.column > 0 && marker.path.endsWith(`/${role}/Main.java`)), '实时问题应带有准确位置并归属当前模型');
  return diagnostics;
}
async function acceptSuggestion(label, role = 'optimized', minimumMatches = 1) {
  await page.keyboard.press('Control+Space');
  const widget = page.locator(`.role-${role} .suggest-widget.visible`);
  await widget.waitFor({ timeout: 15000 });
  await widget.locator('.monaco-list-row').filter({ hasText: new RegExp(`\\b${label}\\b`) }).first().waitFor({ timeout: 15000 });
  const candidateText = await widget.locator('.monaco-list-row').filter({ hasText: new RegExp(`\\b${label}\\b`) }).allTextContents();
  assert.ok(candidateText.length >= minimumMatches, `${label} 应保留 ${minimumMatches} 个不同签名的候选项`);
  // Choose the visible item with real suggestion-list keys, then commit its edits with Enter.
  const selection = await widget.evaluate((element, label) => {
    const rows = [...element.querySelectorAll('.monaco-list-row')];
    return { target: rows.findIndex(row => new RegExp(`\\b${label}\\b`).test(row.textContent)), focused: rows.findIndex(row => row.classList.contains('focused')) };
  }, label);
  assert.ok(selection.target >= 0, `${label} 应出现在实际补全列表`);
  if (selection.focused < 0) {
    await page.keyboard.press('ArrowDown');
    selection.focused = await widget.locator('.monaco-list-row').evaluateAll(rows => rows.findIndex(row => row.classList.contains('focused')));
  }
  for (let step = 0; step < Math.abs(selection.target - selection.focused); step++) await page.keyboard.press(selection.target > selection.focused ? 'ArrowDown' : 'ArrowUp');
  await page.keyboard.press('Enter');
  return candidateText;
}
async function capture(file) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(file, Buffer.from(png, 'base64'));
}
async function fullscreen(expected) {
  await page.waitForFunction(async expected => document.querySelector('.app-shell').classList.contains('is-fullscreen') === expected && await window.duipai.isFullscreen() === expected, expected, { timeout: 10000 });
}
async function saveResults(status, error) {
  await writeFile(path.join(root, 'docs', 'editor-results.json'), JSON.stringify({ date: new Date().toISOString(), status, results, externalRequests: external, pageErrors: errors, ...(error ? { error: error.message } : {}) }, null, 2));
}
async function diagnose() {
  return page.evaluate(async source => {
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, operation: 'analyze' }) };
    let direct, method;
    try { const response = await fetch('/api/editor/java/analyze', options); direct = { status: response.status, body: await response.text() }; }
    catch (error) { direct = { error: String(error), stack: error.stack }; }
    try { const client = { transport: fetch }; const response = await client.transport('/api/editor/java/analyze', options); method = { status: response.status, body: await response.text() }; }
    catch (error) { method = { error: String(error), stack: error.stack }; }
    return { direct, method, footer: [...document.querySelectorAll('.editor-footer')].map(element => element.textContent) };
  }, validCode);
}

try {
  await launch();
  if (process.argv.includes('--diagnose')) {
    console.log(JSON.stringify({ diagnosis: await diagnose(), analysisResponses, analysisFailures }, null, 2));
    await app.close(); app = null; process.exit(0);
  }
  await test('三个 Java 模型独立且实时 javac 检查无需启动对拍', async () => {
    await Promise.all(roles.map(role => expectClean(role, validCode)));
    const bad = validCode.replace('System.out.println(7);', 'System.out.println(7)');
    await setCode('brute', bad);
    const diagnostics = await expectErrors('brute');
    assert.ok(diagnostics.some(marker => marker.line === 3), '缺少分号应定位在出错行');
    await page.locator('.role-brute .editor-footer').getByRole('button').click();
    await page.locator('.role-brute .java-problems').getByRole('button').first().click();
    assert.equal(await page.evaluate(() => window.__editorAcceptanceEditors.brute.getSelection().startLineNumber), 3, '问题列表应选择从错误行开始的诊断范围');
    assert.deepEqual(await markers('generator'), []);
    assert.deepEqual(await markers('optimized'), []);
    assert.equal((await api(`/api/problems/${problem.id}/runs`)).length, 0, '编辑器检查不应创建运行记录');
    await setCode('brute', validCode); await expectClean('brute', validCode);
  });
  await test('Ctrl+Space 的 JDK 类补全替换词中完整标识符并自动导入', async () => {
    const source = `public class Main {\n    public static void main(String[] args) {\n        ArrayL\n    }\n}`;
    await setCode('optimized', source, 'ArrayL', -2); // Arra|yL must become ArrayList without leaving the suffix.
    await acceptSuggestion('ArrayList');
    await page.waitForFunction(() => /^import java\.util\.ArrayList;/m.test(window.__editorAcceptanceEditors.optimized.getValue()), null, { timeout: 10000 });
    const inserted = await value();
    assert.match(inserted, /\bArrayList\b/);
    assert.equal((inserted.match(/import java\.util\.ArrayList;/g) || []).length, 1, '自动导入不得重复');
    assert.match(inserted, /\n        ArrayList\n/, '词中补全应替换整个标识符并清除原后缀');
  });
  await test('sout 代码模板通过补全列表插入并进入可编辑占位符', async () => {
    const source = `public class Main {\n    public static void main(String[] args) {\n        sout\n    }\n}`;
    await setCode('optimized', source, 'sout');
    await acceptSuggestion('sout');
    await page.waitForFunction(() => window.__editorAcceptanceEditors.optimized.getValue().includes('System.out.println('), null, { timeout: 10000 });
    await page.keyboard.type('42');
    const inserted = await value();
    assert.match(inserted, /System\.out\.println\(42\);/);
    await page.keyboard.press('Escape');
    await expectClean('optimized', inserted);
  });
  await test('局部变量的语义成员补全显示 Scanner.nextInt 并插入调用', async () => {
    const source = `import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner input = new Scanner(System.in);\n        System.out.println(input.nextI);\n    }\n}`;
    await setCode('optimized', source, 'input.nextI');
    const overloads = await acceptSuggestion('nextInt', 'optimized', 2);
    assert.ok(new Set(overloads).size >= 2, '相同方法名的不同签名应在实际列表中分别显示');
    await page.waitForFunction(() => window.__editorAcceptanceEditors.optimized.getValue().includes('input.nextInt('), null, { timeout: 10000 });
    await page.keyboard.press('Escape');
    await expectClean('optimized', await value());
  });
  await test('Alt+Enter 从真实诊断提供导入修复且清除错误', async () => {
    const source = `public class Main {\n    public static void main(String[] args) {\n        ArrayList<Integer> values = new ArrayList<>();\n        System.out.println(values.size());\n    }\n}`;
    await setCode('optimized', source, 'ArrayList<Integer>', -'<Integer>'.length);
    await expectErrors('optimized');
    await page.keyboard.press('Alt+Enter');
    const fix = page.getByText('导入 java.util.ArrayList', { exact: true });
    await fix.waitFor({ timeout: 15000 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /^import java\.util\.ArrayList;/m.test(window.__editorAcceptanceEditors.optimized.getValue()), null, { timeout: 10000 });
    await expectClean('optimized', await value());
  });
  await test('Ctrl+B 跳转本文件声明，Ctrl+P 显示当前参数签名', async () => {
    const source = `public class Main {\n    static int add(int left, int right) { return left + right; }\n    public static void main(String[] args) {\n        int answer = add(1, 2);\n        System.out.println(answer);\n    }\n}`;
    await setCode('optimized', source, 'add(1', -2); // add|( should still resolve the call declaration.
    await page.keyboard.press('Control+b');
    await page.waitForFunction(() => window.__editorAcceptanceEditors.optimized.getPosition().lineNumber === 2, null, { timeout: 15000 });
    await setCode('optimized', source, 'add(1, ');
    await page.keyboard.press('Control+p');
    const hints = page.locator('.role-optimized .parameter-hints-widget.visible');
    await hints.waitFor({ timeout: 15000 });
    assert.match(await hints.innerText(), /add\(.*left.*right/);
    assert.match(await hints.locator('.parameter.active').innerText(), /right/);
    await page.keyboard.press('Escape');
  });
  await test('Ctrl+Alt+L 修正缩进并保留注释和撤销记录', async () => {
    const source = `public class Main {\npublic static void main(String[] args) {\n// 保留注释内容 { }\nSystem.out.println("保留字符串 { }");\n}\n}`;
    await setCode('optimized', source, 'System.out');
    await page.keyboard.press('Control+Alt+l');
    await page.waitForFunction(() => window.__editorAcceptanceEditors.optimized.getValue().includes('\n    public static void main'), null, { timeout: 10000 });
    const formatted = await value();
    assert.match(formatted, /\n        System\.out\.println/);
    assert.ok(formatted.includes('// 保留注释内容 { }'));
    assert.ok(formatted.includes('"保留字符串 { }"'));
    await page.keyboard.press('Control+z'); await expectValue('optimized', source);
    await page.getByRole('button', { name: '格式化优化解代码', exact: true }).click();
    await expectValue('optimized', formatted);
    await expectClean('optimized', formatted);
  });
  await test('Ctrl+D 复制行、Ctrl+Y 删除行且可以逐步撤销', async () => {
    const source = validCode.replace('System.out.println(7);', 'int number = 7;');
    await setCode('optimized', source, 'int number', -'int number'.length);
    await page.keyboard.press('Control+d');
    await page.waitForFunction(() => (window.__editorAcceptanceEditors.optimized.getValue().match(/int number = 7;/g) || []).length === 2, null, { timeout: 10000 });
    const duplicated = await value();
    await page.keyboard.press('Control+y'); await expectValue('optimized', source);
    await page.keyboard.press('Control+z'); await expectValue('optimized', duplicated);
    await page.keyboard.press('Control+z'); await expectValue('optimized', source);
  });
  await test('Ctrl+F12 文件结构可点击方法并跳转到声明', async () => {
    const source = `public class Main {\n    static int twice(int value) { return value * 2; }\n    public static void main(String[] args) {\n        System.out.println(twice(7));\n    }\n}`;
    await setCode('optimized', source, 'System.out');
    await page.keyboard.press('Control+F12');
    const outline = page.locator('.role-optimized .java-outline');
    await outline.waitFor({ timeout: 15000 });
    await outline.getByRole('button', { name: /twice/ }).click();
    await page.waitForFunction(() => window.__editorAcceptanceEditors.optimized.getPosition().lineNumber === 2, null, { timeout: 10000 });
    await outline.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '优化解文件结构', exact: true }).click();
    await outline.waitFor(); await page.keyboard.press('Escape');
    await outline.waitFor({ state: 'hidden' });
  });
  await test('延迟的旧诊断响应无法覆盖新代码检查结果', async () => {
    const stale = validCode.replace('System.out.println(7);', 'System.out.println(missingOldSymbol);') + '\n// stale-diagnostic';
    const fresh = validCode + '\n// fresh-diagnostic';
    let release, received;
    const held = new Promise(resolve => { release = resolve; });
    const intercepted = new Promise(resolve => { received = resolve; });
    let oldResponse;
    await page.route('**/api/editor/java/analyze', async route => {
      const request = route.request().postDataJSON();
      if (request.operation !== 'analyze' || request.source !== stale) { await route.continue(); return; }
      oldResponse = await route.fetch({ timeout: 30000 });
      received(); await held;
      await route.fulfill({ response: oldResponse }).catch(() => {}); // A correctly aborted superseded request may already be gone.
    });
    try {
      await setCode('optimized', stale);
      let deadline;
      try {
        await Promise.race([intercepted, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('未捕获旧代码的实时分析请求')), 30000); })]);
      } finally { clearTimeout(deadline); }
      const response = await oldResponse.json();
      assert.ok(response.diagnostics?.length > 0, '被延迟的响应必须包含真实旧代码错误');
      await setCode('optimized', fresh); await expectClean('optimized', fresh);
      release(); await wait(1000);
      assert.deepEqual(await markers('optimized'), [], '释放旧响应后不能重新出现过期错误');
      await expectClean('optimized', fresh);
    } finally { release(); await page.unroute('**/api/editor/java/analyze'); }
  });
  await test('标签页和全屏保留三个模型、光标、代码及撤销状态', async () => {
    await page.getByRole('button', { name: '分栏模式', exact: true }).click();
    for (const role of roles) await setCode(role, validCode + `\n// ${role} 独立模型\n` + Array.from({ length: 90 }, (_, index) => `// ${index + 1}`).join('\n'));
    await page.evaluate(() => {
      window.__editorAcceptanceViews = Object.fromEntries(Object.entries(window.__editorAcceptanceEditors).map(([role, editor]) => {
        editor.pushUndoStop(); editor.executeEdits('editor-isolation', [{ range: new window.monaco.Range(1, 1, 1, 1), text: `// ${role} 可撤销编辑\n` }]); editor.pushUndoStop();
        editor.setPosition({ lineNumber: 15, column: 3 }); editor.setScrollTop(150);
        return [role, { position: editor.getPosition(), value: editor.getValue(), uri: editor.getModel().uri.toString() }];
      }));
    });
    await page.getByRole('button', { name: '标签页模式', exact: true }).click();
    for (const role of roles) await page.getByRole('tab', { name: roleLabels[role], exact: true }).click();
    await page.getByRole('button', { name: '全屏模式', exact: true }).click(); await fullscreen(true);
    assert.equal(await page.locator('.code-panel:visible').count(), 1);
    await page.keyboard.press('Escape'); await fullscreen(false);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await page.evaluate(() => Object.fromEntries(Object.entries(window.__editorAcceptanceEditors).map(([role, editor]) => [role, {
      sameEditor: window.monaco.editor.getEditors().includes(editor), position: editor.getPosition(), value: editor.getValue(), uri: editor.getModel().uri.toString(), canUndo: editor.getModel().canUndo(), expected: window.__editorAcceptanceViews[role],
    }])));
    assert.equal(new Set(Object.values(state).map(value => value.uri)).size, 3);
    for (const role of roles) {
      assert.equal(state[role].sameEditor, true); assert.equal(state[role].canUndo, true);
      assert.deepEqual(state[role].position, state[role].expected.position); assert.equal(state[role].value, state[role].expected.value);
    }
    await page.getByRole('button', { name: '分栏模式', exact: true }).click();
    await page.keyboard.press('Control+s');
    await page.waitForFunction(async ({ id, state }) => {
      const stored = await fetch(`/api/problems/${id}`).then(response => response.json());
      return Object.entries(state).every(([role, value]) => stored.codes[role] === value.value);
    }, { id: problem.id, state }, { timeout: 10000 });
  });
  await test('编辑器工具栏可用且全资源本地加载、无页面异常', async () => {
    const screenshotCode = `import java.util.Scanner;\n\npublic class Main {\n    static long sumTo(long n) {\n        return n * (n + 1) / 2;\n    }\n\n    public static void main(String[] args) {\n        Scanner input = new Scanner(System.in);\n        long n = input.nextLong();\n        System.out.println(sumTo(n));\n    }\n}`;
    for (const role of roles) await setCode(role, role === 'optimized' ? screenshotCode : validCode);
    await expectClean('optimized', screenshotCode);
    await page.getByRole('button', { name: '优化解编辑器快捷键', exact: true }).click();
    assert.ok((await page.locator('.code-panel.role-optimized').innerText()).includes('Ctrl'), '快捷键帮助应显示按键说明');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '优化解文件结构', exact: true }).click();
    await page.locator('.role-optimized .java-outline').waitFor();
    await capture(path.join(root, 'docs', 'java-editor.png'));
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
  });
  await app.close(); app = null;
  await saveResults('PASS');
  console.log(`\n${results.length} 项 Java 编辑器验收通过。截图 docs/java-editor.png`);
} catch (error) {
  if (page && !page.isClosed()) {
    await capture(path.join(directory, 'failure.png')).catch(() => {});
    const state = await page.evaluate(() => ({ text: document.body.innerText, editors: Object.fromEntries(Object.entries(window.__editorAcceptanceEditors || {}).map(([role, editor]) => [role, { source: editor.getValue(), position: editor.getPosition(), markers: window.monaco.editor.getModelMarkers({ owner: 'java-live', resource: editor.getModel().uri }) }])) })).catch(() => null);
    await writeFile(path.join(directory, 'failure.json'), JSON.stringify({ error: error.message, results, state, analysisResponses, analysisFailures, diagnosis: await diagnose().catch(() => null) }, null, 2)).catch(() => {});
  }
  await saveResults('FAIL', error).catch(() => {});
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
