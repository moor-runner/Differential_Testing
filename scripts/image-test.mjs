import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root, backendJar } from './common.mjs';

const { prepareBackendRuntime } = createRequire(import.meta.url)('../electron/backend-runtime.cjs');
const directory = path.join(root, 'tmp', 'image-tests', new Date().toISOString().replace(/[:.]/g, '-'));
const data = path.join(directory, 'data'), profile = path.join(directory, 'profile');
await mkdir(directory, { recursive: true });
const results = [], errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page;
async function test(name, callback) { const started = Date.now(); await callback(); results.push({ name, status: 'PASS', elapsedMs: Date.now() - started }); console.log(`PASS ${name}`); }
async function select(file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '上传题面图片', exact: true }).click()]);
  await chooser.setFiles(file);
}
async function settled() { await page.getByRole('button', { name: '上传题面图片', exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('.statement-footer .spin')); }
async function openImage(name) {
  const thumbnail = page.getByRole('button', { name: `查看图片：${name}`, exact: true });
  await thumbnail.locator('img').evaluate(image => image.decode());
  await thumbnail.click();
  await page.getByRole('dialog', { name: '图片预览', exact: true }).waitFor();
}
async function assertFits(width, height) {
  const box = await page.locator('.image-viewer').evaluate(dialog => {
    const bounds = dialog.getBoundingClientRect(), image = dialog.querySelector('img').getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: image.width, height: image.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.ok(box.left >= 0 && box.right <= box.viewportWidth + 1 && box.top >= 0 && box.bottom <= box.viewportHeight + 1, JSON.stringify(box));
  assert.ok(box.width <= width && box.height <= height);
  assert.ok(Math.abs(box.width / box.height - width / height) < 0.005);
  return box;
}
async function fixture(name, width, height) {
  const png = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#eaf5f3'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#17665e'; context.fillRect(0, 0, width, Math.min(160, height / 3));
    context.fillStyle = '#ffffff'; context.font = `${Math.min(64, height / 8)}px sans-serif`; context.fillText(`${width} × ${height}`, 24, Math.min(100, height / 4));
    context.strokeStyle = '#60a59b'; context.lineWidth = 4; context.strokeRect(20, 20, width - 40, height - 40);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height });
  const file = path.join(directory, name); await writeFile(file, Buffer.from(png, 'base64')); return file;
}

try {
  const env = { ...process.env, DUIPAI_TEST_HIDDEN: '1', DUIPAI_DATA_DIR: data, DUIPAI_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 }); page.on('pageerror', error => errors.push(error.message));
  await page.getByText('本地服务已连接', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '新建题目', exact: true }).click();
  await page.getByLabel('题目标题').fill('图片插入与分辨率回归');
  await page.getByRole('button', { name: '创建题目', exact: true }).click();
  const small = await fixture('小图.png', 320, 180), wide = await fixture('横向大图.png', 3840, 2160), tall = await fixture('纵向长图.png', 800, 4000);
  await test('点击插图选择文件后结束加载并直接显示预览', async () => {
    await select(small); await settled();
    await page.getByRole('button', { name: '查看图片：小图.png', exact: true }).waitFor();
    await openImage('小图.png'); const fit = await assertFits(320, 180); assert.equal(fit.width, 320); assert.equal(fit.height, 180);
    await page.getByText('320 × 180 px · 100%', { exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: '图片预览', exact: true }).waitFor({ state: 'hidden' });
  });
  await test('高分辨率横图保持比例缩放、原始尺寸与截图', async () => {
    await select(wide); await settled(); await openImage('横向大图.png'); await assertFits(3840, 2160);
    await page.getByRole('button', { name: '原始尺寸', exact: true }).click();
    assert.equal(await page.locator('.image-viewer img').evaluate(image => image.getBoundingClientRect().width), 3840);
    assert.ok(await page.locator('.image-viewer-stage').evaluate(stage => stage.scrollWidth > stage.clientWidth && stage.scrollHeight > stage.clientHeight));
    await page.getByRole('button', { name: '适应窗口', exact: true }).click(); await assertFits(3840, 2160);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(root, 'docs/image-preview.png'), Buffer.from(png, 'base64'));
    await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  });
  await test('纵向长图与窗口缩小时重新适配', async () => {
    await select(tall); await settled(); await openImage('纵向长图.png'); const before = await assertFits(800, 4000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700));
    await page.waitForFunction(() => innerWidth < 1200); const after = await assertFits(800, 4000); assert.ok(after.height < before.height);
    await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 980));
  });
  await test('服务端拒绝损坏图片后按钮恢复，可再次插图', async () => {
    const invalid = path.join(directory, '损坏.png'); await writeFile(invalid, 'not an image');
    await select(invalid); await page.getByText('图片无法解码，请选择有效图片', { exact: true }).or(page.getByText('仅支持有效的 PNG、JPEG、GIF 图片', { exact: true })).waitFor();
    await settled(); assert.ok(await page.getByRole('button', { name: '上传题面图片', exact: true }).isEnabled());
    await select(small); await settled(); assert.equal(await page.locator('.markdown img').count(), 4);
  });
  await test('请求卡住可取消，恢复插入按钮', async () => {
    let pending;
    const handler = route => { pending = route; };
    await page.route('**/api/images', handler);
    await select(small); await page.getByText('正在保存图片 1/1', { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('已取消插入图片。', { exact: true }).waitFor(); await settled();
    await pending?.abort().catch(() => {}); await page.unroute('**/api/images', handler);
  });
  await test('无响应上传超时后结束转圈，保留原题面', async () => {
    const before = await page.locator('.markdown img').count(); let pending;
    const handler = route => { pending = route; }; await page.route('**/api/images', handler);
    await page.evaluate(() => { window.__originalUploadTimeout = AbortSignal.timeout; AbortSignal.timeout = () => window.__originalUploadTimeout(200); });
    try { await select(small); await page.getByText('图片保存超时，请检查本地服务后重试。', { exact: true }).waitFor(); await settled(); assert.equal(await page.locator('.markdown img').count(), before); }
    finally { await page.evaluate(() => { AbortSignal.timeout = window.__originalUploadTimeout; delete window.__originalUploadTimeout; }); await pending?.abort().catch(() => {}); await page.unroute('**/api/images', handler); }
  });
  await test('构建替换原始JAR后独立运行副本仍能处理图片', async () => {
    const source = path.join(directory, 'rebuild-source.jar'); await copyFile(backendJar, source);
    const runtime = prepareBackendRuntime(source, path.join(directory, 'runtime-profile'));
    const token = randomBytes(32).toString('hex');
    const java = process.env.DUIPAI_JAVA_HOME || process.env.JAVA_HOME;
    const executable = java ? path.join(java, 'bin/java.exe') : 'java';
    const child = spawn(executable, ['-Xmx512m', '-jar', runtime.jar, '--server.port=0', `--duipai.parent-pid=${process.pid}`], { windowsHide: true, env: { ...process.env, DUIPAI_TOKEN: token, DUIPAI_DATA_DIR: path.join(directory, 'isolated-data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let origin;
    try {
      origin = await new Promise((resolve, reject) => {
        let output = ''; const timer = setTimeout(() => reject(new Error('Isolated backend startup timed out')), 30000);
        child.stdout.on('data', chunk => { output += chunk; const match = output.match(/DUIPAI_READY:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
        child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Isolated backend exit ${code}`)); });
      });
      await writeFile(source, 'simulated replacement by an unfinished build');
      const form = new FormData(); form.append('file', new File([await readFile(wide)], 'large.png', { type: 'image/png' }));
      const response = await fetch(`${origin}/api/images`, { method: 'POST', headers: { 'X-Duipai-Token': token }, body: form, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200); const image = await response.json();
      const saved = await fetch(`${origin}${image.url}`, { headers: { 'X-Duipai-Token': token }, signal: AbortSignal.timeout(5000) }); assert.equal(saved.status, 200); assert.ok((await saved.arrayBuffer()).byteLength > 0);
    } finally {
      if (origin) await fetch(`${origin}/api/shutdown`, { method: 'POST', headers: { 'X-Duipai-Token': token }, signal: AbortSignal.timeout(3000) }).catch(() => {});
      for (let i = 0; i < 100 && child.exitCode === null; i++) await wait(100);
      if (child.exitCode === null) child.kill('SIGKILL');
      runtime.cleanup();
    }
    const log = await readFile(path.join(data, 'backend.log'), 'utf8'); assert.match(log, /backend-runtime[\\/]run-/);
  });
  await test('图片交互没有未捕获异常，重启后图片仍然可预览', async () => {
    await page.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 10000 });
    await app.close(); app = null;
    const env = { ...process.env, DUIPAI_TEST_HIDDEN: '1', DUIPAI_DATA_DIR: data, DUIPAI_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], cwd: root, env, timeout: 60000 });
    page = await app.firstWindow({ timeout: 60000 }); page.on('pageerror', error => errors.push(error.message));
    await page.getByText('本地服务已连接', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '查看图片：纵向长图.png', exact: true }).waitFor(); await openImage('纵向长图.png'); await assertFits(800, 4000); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.markdown img').count(), 4); assert.deepEqual(errors, []);
  });
  await writeFile(path.join(root, 'docs/image-results.json'), JSON.stringify({ date: new Date().toISOString(), version: '1.0.1', results }, null, 2));
  console.log(`${results.length} 项图片回归通过。`);
} catch (error) {
  if (page && !page.isClosed()) console.error((await page.locator('body').innerText().catch(() => '')).slice(-1200));
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
