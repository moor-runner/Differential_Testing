import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './common.mjs';

// Run after npm run build. This suite deliberately uses the installed Windows
// OCR engine once. Later applications reuse its raw response; cancellation and
// errors also mock the endpoint. Each launch has isolated problem data/profile.
const directory = path.join(root, 'tmp', 'recognition-tests', new Date().toISOString().replace(/[:.]/g, '-'));
const data = path.join(directory, 'data'), profile = path.join(directory, 'profile');
await mkdir(directory, { recursive: true });
const results = [], errors = [];
const recognitionRoute = '**/api/images/*/recognize';
const original = `# 原有标题

## 题目描述
需要被替换的旧题目描述。

## 输入格式
需要被替换的旧输入格式。

## 输出格式
需要被替换的旧输出格式。

## 测试样例
需要被替换的旧测试样例。

## 数据范围
需要被替换的旧数据范围。

## 个人笔记
这一段个人笔记需要完整保留。`;
const edits = {
  '题目标题': '数组求和（识别后校正）',
  '题目描述': '给定 n 个整数，求这些整数的总和。识别后可以手动校正文字。',
  '输入格式': '第一行输入一个整数 n。\n第二行输入 n 个整数，以空格分隔。',
  '输出格式': '输出这 n 个整数的总和。',
  '测试样例': '### 样例输入\n```text\n3\n1 2 3\n```\n\n### 样例输出\n```text\n6\n```',
  '数据范围': '1 <= n <= 100000\n0 <= a_i <= 1000000000',
};
let app, page, recognized, baseline, applied, problemId, fixtureFile;
async function test(name, callback) {
  const started = Date.now();
  await callback();
  results.push({ name, status: 'PASS', elapsedMs: Date.now() - started });
  console.log(`PASS ${name}`);
}
async function launch() {
  const env = { ...process.env, DUIPAI_TEST_HIDDEN: '1', DUIPAI_DATA_DIR: data, DUIPAI_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('本地服务已连接', { exact: true }).waitFor({ timeout: 30000 });
}
async function readStatement() {
  if (!await page.getByLabel('Markdown 题面', { exact: true }).isVisible()) await page.getByRole('button', { name: '编辑', exact: true }).click();
  return page.getByLabel('Markdown 题面', { exact: true }).inputValue();
}
async function savedProblem(id = problemId) {
  await page.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 10000 });
  return page.evaluate(async id => {
    const response = await fetch(`/api/problems/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Read saved problem failed: ${response.status}`);
    return response.json();
  }, id);
}
async function openRecognition() {
  await page.getByRole('button', { name: '识别图片题目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '识别图片题目', exact: true });
  await dialog.waitFor();
  return dialog;
}
async function closeRecognition(dialog) {
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function screenshot(file) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(png, 'base64'));
}
async function fixture() {
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1240; canvas.height = 1690;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111111'; context.textBaseline = 'top';
    const lines = [
      ['数组求和', 48, true],
      ['题目描述', 36, true],
      ['给定 n 个整数，求这些整数的总和。', 36],
      ['输入格式', 36, true],
      ['第一行包含一个整数 n。', 36],
      ['第二行包含 n 个整数，以空格分隔。', 36],
      ['输出格式', 36, true],
      ['输出一个整数，表示所有整数的总和。', 36],
      ['样例输入', 36, true],
      ['3', 36],
      ['1 2 3', 36],
      ['样例输出', 36, true],
      ['6', 36],
      ['数据范围', 36, true],
      ['1 <= n <= 100000', 36],
      ['0 <= a_i <= 1000000000', 36],
    ];
    let y = 50;
    for (const [text, size, heading] of lines) {
      if (heading && y > 50) y += 30;
      context.font = `${heading ? 'bold ' : ''}${size}px "Microsoft YaHei", "Segoe UI", sans-serif`;
      context.fillText(text, 55, y); y += size + 24;
    }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const file = path.join(directory, '数组求和题目截图.png');
  await writeFile(file, Buffer.from(png, 'base64'));
  return file;
}

try {
  await launch();
  await test('真实 Windows OCR 状态与已安装语言可用', async () => {
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/images/recognition/status');
      if (!response.ok) throw new Error(`OCR status endpoint failed: ${response.status}`);
      return response.json();
    });
    assert.equal(status.available, true, `Windows OCR unavailable: ${status.message || JSON.stringify(status)}`);
    assert.ok(Array.isArray(status.languages) && status.languages.length > 0, JSON.stringify(status));
    await writeFile(path.join(directory, 'ocr-status.json'), JSON.stringify(status, null, 2));
  });
  await page.getByRole('button', { name: '新建题目', exact: true }).click();
  await page.getByLabel('题目标题', { exact: true }).fill('图片识别分区验收');
  await page.getByRole('button', { name: '创建题目', exact: true }).click();
  await readStatement();
  await page.getByLabel('Markdown 题面', { exact: true }).fill(original);
  problemId = await page.evaluate(async () => (await (await fetch('/api/problems')).json())[0].id);
  await test('上传完整中文题目截图并显示原图', async () => {
    fixtureFile = await fixture();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '上传题面图片', exact: true }).click()]);
    await chooser.setFiles(fixtureFile);
    await page.getByRole('button', { name: '查看图片：数组求和题目截图.png', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.statement-footer .spin'));
    baseline = await readStatement();
    assert.match(baseline, /!\[数组求和题目截图\.png\]\(\/api\/images\//);
    assert.equal((await savedProblem()).statement, baseline);
  });
  await test('取消进行中的识别不会改写题面并恢复操作', async () => {
    let pending;
    const handler = route => { pending = route; };
    await page.route(recognitionRoute, handler);
    try {
      const dialog = await openRecognition();
      await dialog.getByRole('button', { name: '开始识别', exact: true }).click();
      await dialog.getByRole('button', { name: '取消识别', exact: true }).waitFor();
      await dialog.getByRole('button', { name: '取消识别', exact: true }).click();
      await dialog.getByRole('button', { name: '开始识别', exact: true }).waitFor();
      assert.ok(await dialog.getByRole('button', { name: '开始识别', exact: true }).isEnabled());
      await closeRecognition(dialog);
      assert.equal(await readStatement(), baseline);
      assert.equal((await savedProblem()).statement, baseline);
    } finally {
      await pending?.abort().catch(() => {});
      await page.unroute(recognitionRoute, handler);
    }
  });
  await test('识别服务错误可见且不写入题面', async () => {
    const message = '验收模拟：识别服务暂时不可用，请重试。';
    const handler = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message }) });
    await page.route(recognitionRoute, handler);
    try {
      const dialog = await openRecognition();
      await dialog.getByRole('button', { name: '开始识别', exact: true }).click();
      await dialog.getByText(message, { exact: true }).waitFor();
      assert.ok(await dialog.getByRole('button', { name: '开始识别', exact: true }).isEnabled());
      await closeRecognition(dialog);
      assert.equal(await readStatement(), baseline);
      assert.equal((await savedProblem()).statement, baseline);
    } finally { await page.unroute(recognitionRoute, handler); }
  });
  let dialog;
  await test('真实中文 OCR 自动映射题目、格式、样例及数据范围', async () => {
    dialog = await openRecognition();
    const responsePromise = page.waitForResponse(response => /\/api\/images\/[^/]+\/recognize$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 90000 });
    await dialog.getByRole('button', { name: '开始识别', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    recognized = await response.json();
    await writeFile(path.join(directory, 'recognized-image.json'), JSON.stringify(recognized, null, 2));
    assert.equal(recognized.width, 1240); assert.equal(recognized.height, 1690);
    assert.ok(recognized.language && Array.isArray(recognized.lines) && recognized.lines.length >= 12, JSON.stringify(recognized));
    for (const line of recognized.lines) {
      assert.equal(typeof line.text, 'string');
      assert.ok([line.x, line.y, line.width, line.height].every(Number.isFinite), JSON.stringify(line));
      assert.ok(line.x >= 0 && line.y >= 0 && line.width > 0 && line.height > 0 && line.x + line.width <= recognized.width + 1 && line.y + line.height <= recognized.height + 1, JSON.stringify(line));
    }
    // Windows zh-Hans OCR separates Chinese glyphs with spaces. This is valid
    // raw OCR output; the frontend joins them when building section headings.
    const raw = recognized.lines.map(line => line.text).join('\n').replace(/(?<=[\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g, '');
    assert.ok(raw.trim().length > 50, 'The real OCR response must contain recognized statement text');
    assert.match(raw, /输入格式/); assert.match(raw, /输出格式/); assert.match(raw, /样例输入/); assert.match(raw, /样例输出/); assert.match(raw, /数据范围/);
    await dialog.getByLabel('题目描述', { exact: true }).waitFor({ timeout: 10000 });
    assert.ok((await dialog.getByLabel('题目标题', { exact: true }).inputValue()).trim(), 'The image title must map to an editable title region');
    assert.match(await dialog.getByLabel('题目描述', { exact: true }).inputValue(), /整数/);
    assert.match(await dialog.getByLabel('输入格式', { exact: true }).inputValue(), /第一行/);
    assert.match(await dialog.getByLabel('输出格式', { exact: true }).inputValue(), /总和/);
    const samples = await dialog.getByLabel('测试样例', { exact: true }).inputValue();
    assert.match(samples, /1\s*2\s*3/); assert.match(samples, /6/);
    assert.match(await dialog.getByLabel('数据范围', { exact: true }).inputValue(), /100000/);
    assert.ok(await dialog.locator('.recognition-region').count() >= 5, 'Recognized sections must map to visible image regions');
    const regions = await dialog.locator('.recognition-region').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { width: box.width, height: box.height };
    }));
    assert.ok(regions.every(region => region.width > 0 && region.height > 0), JSON.stringify(regions));
    await dialog.getByLabel('测试样例', { exact: true }).scrollIntoViewIfNeeded();
    await dialog.getByLabel('测试样例', { exact: true }).focus();
    await screenshot(path.join(root, 'docs', 'recognition-preview.png'));
  });
  await test('区域可重新映射，取消勾选保留原区域且可撤销替换', async () => {
    await dialog.getByLabel('数据范围映射区域', { exact: true }).selectOption('notes');
    assert.match(await dialog.getByLabel('提示与说明', { exact: true }).inputValue(), /100000/);
    await dialog.getByLabel('提示与说明映射区域', { exact: true }).selectOption('constraints');
    assert.match(await dialog.getByLabel('数据范围', { exact: true }).inputValue(), /100000/);
    for (const [label, text] of Object.entries(edits)) await dialog.getByLabel(label, { exact: true }).fill(text);
    await dialog.getByRole('checkbox', { name: '应用数据范围', exact: true }).uncheck();
    assert.ok(await dialog.locator('.recognition-region.kind-constraints.excluded').count() > 0);
    await dialog.getByRole('button', { name: '应用到题面', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const partial = await readStatement();
    assert.ok(partial.includes(edits['题目描述']));
    assert.ok(partial.includes('需要被替换的旧数据范围。'), 'Unchecked constraint region must preserve the original text');
    assert.ok(!partial.includes(edits['数据范围']), 'Unchecked constraint region must not be inserted');
    assert.equal((await savedProblem()).statement, partial);
    await page.getByRole('button', { name: '撤销识别替换', exact: true }).click();
    assert.equal(await readStatement(), baseline);
    assert.equal((await savedProblem()).statement, baseline);
    await page.getByRole('button', { name: '撤销识别替换', exact: true }).waitFor({ state: 'hidden' });

    // Reuse the actual Windows OCR output for subsequent application checks.
    const handler = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recognized) });
    await page.route(recognitionRoute, handler);
    try {
      dialog = await openRecognition();
      await dialog.getByRole('button', { name: '开始识别', exact: true }).click();
      await dialog.getByLabel('题目描述', { exact: true }).waitFor();
      assert.ok(await dialog.getByRole('checkbox', { name: '应用数据范围', exact: true }).isChecked());
    } finally { await page.unroute(recognitionRoute, handler); }
  });
  await test('各映射区域可校正后替换原文字、保留笔记和图片', async () => {
    for (const [label, text] of Object.entries(edits)) await dialog.getByLabel(label, { exact: true }).fill(text);
    await dialog.getByRole('button', { name: '应用到题面', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    applied = await readStatement();
    for (const text of Object.values(edits)) assert.ok(applied.includes(text), `Corrected section missing: ${text}`);
    assert.doesNotMatch(applied, /需要被替换的旧|原有标题/);
    assert.ok(applied.includes('## 个人笔记\n这一段个人笔记需要完整保留。'));
    const originalImage = baseline.match(/!\[数组求和题目截图\.png\]\([^\n]+\)/)?.[0];
    assert.ok(originalImage && applied.includes(originalImage), 'The original local image must remain in the statement');
    for (const heading of ['输入格式', '输出格式', '测试样例', '数据范围']) assert.equal((applied.match(new RegExp(`^## ${heading}$`, 'gm')) || []).length, 1, `Duplicate section: ${heading}`);
    assert.equal((await savedProblem()).statement, applied);
  });
  await test('编辑识别草稿后取消不会覆盖已经保存的题面', async () => {
    const handler = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recognized) });
    await page.route(recognitionRoute, handler);
    try {
      const draft = await openRecognition();
      await draft.getByRole('button', { name: '开始识别', exact: true }).click();
      await draft.getByLabel('题目描述', { exact: true }).waitFor();
      await draft.getByLabel('题目描述', { exact: true }).fill('取消后不能写入的识别草稿。');
      await closeRecognition(draft);
      assert.equal(await readStatement(), applied);
      assert.equal((await savedProblem()).statement, applied);
    } finally { await page.unroute(recognitionRoute, handler); }
  });
  await test('重启后识别结果完整保存，原图仍可预览且没有未捕获异常', async () => {
    await savedProblem();
    await app.close(); app = null;
    await launch();
    assert.equal(await readStatement(), applied);
    assert.equal((await savedProblem()).statement, applied);
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.getByRole('button', { name: '查看图片：数组求和题目截图.png', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '图片预览', exact: true });
    await preview.waitFor();
    await preview.locator('img').evaluate(image => image.decode());
    assert.deepEqual(await preview.locator('img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight })), { width: 1240, height: 1690 });
    await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    assert.deepEqual(errors, []);
  });
  await test('无图片题目可从识别入口选择截图，自动打开映射窗口且取消保留原文字', async () => {
    await page.getByRole('button', { name: '新建题目', exact: true }).click();
    await page.getByLabel('题目标题', { exact: true }).fill('无图片直接识别入口验收');
    await page.getByRole('button', { name: '创建题目', exact: true }).click();
    await readStatement();
    const text = '# 保留的入口题面\n\n入口识别不自动替换文字。';
    await page.getByLabel('Markdown 题面', { exact: true }).fill(text);
    const newProblemId = await page.evaluate(async () => (await (await fetch('/api/problems')).json()).find(problem => problem.title === '无图片直接识别入口验收').id);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '识别图片题目', exact: true }).click()]);
    await chooser.setFiles(fixtureFile);
    const entry = page.getByRole('dialog', { name: '识别图片题目', exact: true });
    await entry.waitFor();
    assert.ok(await entry.getByRole('checkbox', { name: '选择图片 1', exact: true }).isChecked());
    await entry.getByRole('button', { name: '开始识别', exact: true }).waitFor();
    assert.equal(await entry.locator('.recognition-section').count(), 0);
    await closeRecognition(entry);
    const statement = await readStatement();
    assert.ok(statement.startsWith(text));
    assert.match(statement, /!\[数组求和题目截图\.png\]\(\/api\/images\//);
    assert.equal((await savedProblem(newProblemId)).statement, statement);
    assert.deepEqual(errors, []);
  });
  await test('有原图的整理入口自动识别并允许取消，不提前覆盖已有文字', async () => {
    const before = await readStatement();
    const handler = route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(recognized)});
    await page.route(recognitionRoute, handler);
    try {
      await page.getByRole('button', {name: '整理题面', exact: true}).click();
      const draft = page.getByRole('dialog', {name: '识别图片题目', exact: true});
      await draft.getByLabel('题目描述', {exact: true}).waitFor();
      await closeRecognition(draft);
      assert.equal(await readStatement(), before);
    } finally { await page.unroute(recognitionRoute, handler); }
  });
  await test('无原图的整理入口改善换行并可完整撤销', async () => {
    const before = '# 换行验收\n\n## 题目描述\n给 定 n 个整\n数。\n输出答案。\n\n## 我的思路\n保留我的  原文。\n';
    await page.getByLabel('Markdown 题面', {exact: true}).fill(before);
    await page.getByRole('button', {name: '整理题面', exact: true}).click();
    const formatted = await readStatement();
    assert.match(formatted, /给定 n 个整数。\n\n输出答案。/);
    assert.match(formatted, /## 我的思路\n保留我的  原文。/);
    await page.getByRole('button', {name: '撤销识别替换', exact: true}).click();
    assert.equal(await readStatement(), before);
  });
  if (process.env.DUIPAI_OCR_SOURCE) await test('实际考试截图只保留题目栏，恢复输入输出样例和完整数据范围', async () => {
    const before = '# 数组求和（示例）\n\n旧的考试界面及代码。\n\n## 输入格式\n旧输入\n\n## 输出格式\n旧输出\n\n## 样例\n```text\n混入的代码\n```\n\n生成器通过 `args[0]` 接收种子。三个编辑器中的程序都应为 `public class Main`。\n';
    await page.getByLabel('Markdown 题面', {exact: true}).fill(before);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', {name: '上传题面图片', exact: true}).click()]);
    await chooser.setFiles({name: '原题截图.png', mimeType: 'image/png', buffer: await readFile(process.env.DUIPAI_OCR_SOURCE)});
    await page.getByRole('button', {name: '查看图片：原题截图.png', exact: true}).waitFor();
    await page.waitForFunction(() => !document.querySelector('.statement-footer .spin'));
    await page.getByRole('button', {name: '整理题面', exact: true}).click();
    const draft = page.getByRole('dialog', {name: '识别图片题目', exact: true});
    await draft.getByLabel('题目标题', {exact: true}).waitFor({timeout: 90000});
    assert.equal(await draft.getByLabel('题目标题', {exact: true}).inputValue(), '数字消除游戏');
    assert.equal(await draft.getByLabel('数据范围', {exact: true}).inputValue(), '1 <= n <= 1000000');
    assert.match(await draft.getByLabel('输入格式', {exact: true}).inputValue(), /输入数字 n/);
    assert.match(await draft.getByLabel('输出格式', {exact: true}).inputValue(), /最后剩下的数字/);
    const samples = await draft.getByLabel('测试样例', {exact: true}).inputValue();
    assert.match(samples, /输出样例 1\n\n```text\n1\n```/);
    assert.match(samples, /输出样例 2\n\n```text\n6\n```/);
    await draft.getByRole('button', {name: '应用到题面', exact: true}).click();
    const formatted = await readStatement();
    assert.doesNotMatch(formatted, /SR2026|java.util|public class Main|姓名|考号|三个编辑器|旧的考试/);
    assert.equal(formatted.match(/\/api\/images\//g).length, 1);
    assert.match(formatted, /\n\n从左到右/);
    await writeFile(path.join(directory, 'focused-cleanup.md'), formatted);
    assert.deepEqual(errors, []);
  });
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(root, 'docs', 'recognition-results.json'), JSON.stringify({ date: new Date().toISOString(), version, fixture: directory, results }, null, 2));
  console.log(`${results.length} 项图片识别验收通过。`);
} catch (error) {
  if (page && !page.isClosed()) {
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-2000));
    await screenshot(path.join(directory, 'failure.png')).catch(() => {});
  }
  throw error;
} finally { if (app) await app.close().catch(() => {}); }
