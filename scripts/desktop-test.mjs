import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './common.mjs';

const tag = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(root, 'tmp', 'desktop', tag, 'data');
const profile = path.join(root, 'tmp', 'desktop', tag, 'profile');
await mkdir(dataDir, { recursive: true });
let app, page;
const results = [], external = [], errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function backendPid() {
  const info = await page.evaluate(() => window.duipai.getInfo());
  assert.ok(info.backendPid > 0, 'Electron-owned backend PID should exist'); return info.backendPid;
}
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function launch() {
  const env = { ...process.env, DUIPAI_DATA_DIR: dataDir, DUIPAI_USER_DATA_DIR: profile, DUIPAI_TEST_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:')) external.push(request.url()); });
  await page.getByText('本地服务已连接', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '新建题目', exact: true }).waitFor({ timeout: 10000 });
}
async function api(url, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }, { url, method, body });
}
async function close() {
  if (!app) return;
  const backend = await backendPid();
  const process = app.process();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); }).catch(() => {});
  for (let i = 0; i < 150 && process.exitCode === null; i++) await wait(100);
  assert.notEqual(process.exitCode, null, 'Electron window close should also stop backend and exit');
  assert.equal(isRunning(backend), false, 'Backend must exit with its Electron window');
  app = null;
}
async function test(name, fn) { const t = Date.now(); await fn(); results.push({ name, status: 'PASS', elapsedMs: Date.now() - t }); console.log(`PASS ${name}`); }
async function editCode(role, code) {
  await page.evaluate(({ role, code }) => {
    const model = window.monaco.editor.getModels().find(value => value.uri.path.endsWith(`/${role}/Main.java`));
    if (!model) throw new Error(`Missing local Monaco model: ${role}`);
    model.setValue(code);
  }, { role, code });
}
async function capture(file) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(file, Buffer.from(png, 'base64'));
}
const generator = `public class Main {
    public static void main(String[] args) {
        long seed = Long.parseLong(args[0]);
        int n = (int)Math.floorMod(seed, 5L) + 1;
        System.out.println(n);
    }
}`;
const brute = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        var in = new Scanner(System.in);
        int n = in.nextInt();
        long sum = 0;
        for (int i = 1; i <= n; i++) sum += i;
        System.out.println(sum);
    }
}`;
const wrong = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        var in = new Scanner(System.in);
        int n = in.nextInt();
        // n >= 3 时，故意保留一个错误
        int answer = n >= 3 ? 0 : n * (n + 1) / 2;
        System.out.println(answer);
    }
}`;
let id, initialLayout, savedLayout;
try {
  await launch();
  await test('桌面题目新建、三个本地 Monaco 编辑器和自动保存', async () => {
    await page.getByRole('button', { name: '新建题目', exact: true }).click();
    await page.getByLabel('题目标题').fill('数列求和 · 种子复现示例');
    await page.getByRole('button', { name: '创建题目', exact: true }).click();
    await page.locator('.code-panel .monaco-editor').nth(2).waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.code-panel').count(), 3);
    id = (await api('/api/problems'))[0].id;
    await editCode('generator', generator); await editCode('brute', brute); await editCode('optimized', wrong);
    await page.getByLabel('起始种子').fill('0'); await page.getByLabel('并行度', { exact: true }).fill('1');
    await page.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 10000 });
    const saved = await api(`/api/problems/${id}`);
    assert.equal(saved.codes.optimized, wrong); assert.equal(saved.codes.generator, generator);
  });
  await test('题面公式预览与粘贴、拖入图片', async () => {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const statement = '# 数列求和\n\n给定正整数 $n$，求 $1+2+\\cdots+n$。\n\n## 输入格式\n一行，一个整数 $n$。\n\n## 输出格式\n输出 $n(n+1)/2$。\n\n## 提示\n当 $n \\ge 3$ 时，尝试找出优化解中的错误。\n';
    await page.getByLabel('Markdown 题面').fill(statement);
    // Exercise real component paste/drop handlers using PNG File objects.
    await page.getByLabel('Markdown 题面').evaluate(element => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1cAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelector('.statement-textarea')?.value.includes('clipboard.png'), { timeout: 10000 });
    await page.locator('.statement-panel').evaluate(element => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1cAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelector('.statement-textarea')?.value.includes('dropped.png'), { timeout: 10000 });
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.locator('.markdown .katex').first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.markdown img')].every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator('.markdown img').count(), 2);
    assert.ok(await page.locator('.markdown img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)));
  });
  await test('所有外层分隔条及编辑器尺寸自动保存', async () => {
    initialLayout = await api('/api/settings/layout');
    const handle = page.getByRole('separator', { name: /题目列表宽度/ });
    await handle.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    const rect = await handle.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 + 18, rect.y + rect.height / 2, { steps: 4 }); await page.mouse.up();
    const editorHandle = page.getByRole('separator', { name: /代码编辑器宽度 1/ });
    await editorHandle.focus(); await page.keyboard.press('ArrowRight');
    await wait(650); savedLayout = await api('/api/settings/layout');
    assert.ok(savedLayout.sidebar[0] > (initialLayout.sidebar?.[0] || 16));
    assert.ok(savedLayout.editors[0] > 33.333);
  });
  await test('开始前保存、WA 结果、输入与输出 Diff', async () => {
    await page.getByRole('button', { name: '开始对拍', exact: true }).click();
    await page.getByText('WA · 答案错误', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByText('首个差异：第 1 行', { exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: '用此种子复现', exact: true }).isEnabled());
    await page.locator('.diff-host .monaco-diff-editor').waitFor({ timeout: 15000 });
    const history = await api(`/api/problems/${id}/runs`); assert.equal(history[0].seed, '2');
  });
  await test('用此种子复现与历史代码快照', async () => {
    await page.getByRole('button', { name: '用此种子复现', exact: true }).click();
    await page.getByText('WA · 答案错误', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '代码快照', exact: true }).click();
    await page.getByRole('dialog', { name: '运行代码快照' }).waitFor();
    await page.getByRole('button', { name: '关闭代码快照', exact: true }).click();
    await page.getByRole('dialog', { name: '运行代码快照' }).waitFor({ state: 'hidden' });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await capture(path.join(root, 'docs', 'workbench.png'));
  });
  await test('从历史开始新任务自动展示进度、编译错误行标记', async () => {
    await editCode('brute', 'public class Main { public static void main(String[] args) { missing; } }');
    await page.getByRole('button', { name: /^历史/ }).click();
    await page.getByRole('button', { name: '开始对拍', exact: true }).click();
    await page.getByText('CE · 编译错误', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByText('编译失败，尚未开始运行', { exact: true }).waitFor();
    await page.waitForFunction(() => window.monaco.editor.getModelMarkers({ owner: 'javac' }).some(marker => marker.resource.path.endsWith('/brute/Main.java')));
    await editCode('brute', brute);
  });
  await test('运行中界面响应、实时状态与手动停止', async () => {
    await editCode('optimized', 'public class Main { public static void main(String[] args) { while(true){} } }');
    await page.getByLabel('优化解时限').fill('60000'); await page.getByLabel('并行度', { exact: true }).fill('4');
    await page.getByRole('button', { name: '开始对拍', exact: true }).click();
    await page.getByText('正在对拍', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const area = page.getByLabel('Markdown 题面'); const value = await area.inputValue();
    await area.fill(value + '\n<!-- 界面运行中仍可编辑 -->\n');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await page.getByText('CANCELLED · 已停止', { exact: true }).waitFor({ timeout: 15000 });
    await editCode('optimized', wrong); await page.getByLabel('优化解时限').fill('2000'); await page.getByLabel('并行度', { exact: true }).fill('1');
  });
  await test('窗口关闭前保存、重启恢复题面图片代码与布局', async () => {
    await page.getByLabel('最大轮数').fill('1234');
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.route('**/api/images', async route => { await wait(1500); await route.continue(); });
    await page.getByLabel('Markdown 题面').evaluate(element => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1cAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'closing-upload.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await close(); await launch();
    await page.getByRole('heading', { name: '数列求和 · 种子复现示例', exact: true }).waitFor();
    assert.equal(await page.getByLabel('最大轮数').inputValue(), '1234');
    assert.deepEqual(await api('/api/settings/layout'), savedLayout);
    const persisted = await api(`/api/problems/${id}`); assert.equal(persisted.codes.optimized, wrong); assert.match(persisted.statement, /clipboard\.png/); assert.match(persisted.statement, /dropped\.png/); assert.match(persisted.statement, /closing-upload\.png/);
    await page.locator('.markdown .katex').first().waitFor();
    assert.equal(await page.locator('.markdown img').count(), 3);
    const history = await api(`/api/problems/${id}/runs`); assert.ok(history.length >= 2);
  });
  await test('全资源本地加载及界面无未捕获异常', async () => { assert.deepEqual(external, []); assert.deepEqual(errors, []); });
  await test('桌面异常退出后父进程监视清理后端', async () => {
    const backend = await backendPid();
    const current = await api(`/api/problems/${id}`);
    current.codes.optimized = 'public class Main { public static void main(String[] args) throws Exception { Thread.sleep(30000); } }';
    current.settings.optimizedTimeoutMs = 60000; current.settings.parallelism = 4;
    await api(`/api/problems/${id}`, 'PUT', current);
    const started = await api('/api/jobs', 'POST', { problemId: id });
    for (let i = 0; i < 100; i++) { if ((await api(`/api/jobs/${started.id}`)).state === 'RUNNING') break; await wait(100); }
    // Playwright's Windows launcher PID can differ from Electron's main PID.
    const electronMainPid = await app.evaluate(() => process.pid);
    globalThis.process.kill(electronMainPid, 'SIGKILL');
    for (let i = 0; i < 150 && isRunning(backend); i++) await wait(100);
    assert.equal(isRunning(backend), false, 'Backend parent watchdog should clean up after Electron crash');
    app = null;
  });
  await close();
  await writeFile(path.join(root, 'docs', 'desktop-results.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length} 项桌面验收通过。截图 docs/workbench.png`);
} catch (error) {
  if (page && !page.isClosed()) { await capture(path.join(root, 'tmp', 'desktop-failure.png')).catch(() => {}); console.error((await page.locator('body').innerText().catch(() => '')).slice(0,2000)); }
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
