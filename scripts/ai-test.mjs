import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './common.mjs';

// Run only after the AI frontend/backend have been built. All outbound requests
// go to this loopback mock server, with a fake key and isolated application data.
const directory = path.join(root, 'tmp', 'ai-tests', new Date().toISOString().replace(/[:.]/g, '-'));
const data = path.join(directory, 'data'), profile = path.join(directory, 'profile');
await mkdir(directory, { recursive: true });
const fakeKey = 'sk-duipai-local-ai-acceptance-not-a-real-secret';
const initialModel = 'mock-statement-model', updatedModel = 'mock-statement-model-v2';
const results = [], pageErrors = [], mockFailures = [], calls = [], waiters = [], pendingResponses = new Set(), requestEntries = [];
const privateReasoning = 'PRIVATE_REASONING_SENTINEL 这段内部推理正文不能进入界面或日志。';
let scenario = 'success', app, page, problemId, baseline, applied, originalImage, baselineCodes, diagnosticSuccessId, diagnosticFailureId;
const aiResult = `# 数组求和

## 题目描述
给定 $n$ 个整数，求这些整数的总和。

## 输入格式
第一行包含一个整数 $n$。
第二行包含 $n$ 个整数，以空格分隔。

## 输出格式
输出一个整数，表示所有整数的总和。

## 测试样例
### 样例输入
\`\`\`text
3
1 2 3
\`\`\`

### 样例输出
\`\`\`text
6
\`\`\`

## 数据范围
1 <= n <= 100000
0 <= a_i <= 1000000000`;
const privateNote = '## 个人笔记\nPRIVATE_NOTE_SENTINEL 这段个人笔记只保留在本机。';
const unknownSection = '## 收藏出处\nUNKNOWN_METADATA_SENTINEL 这段自定义信息应完整保留。';
const corrections = {
  '题目标题': '数组求和（AI 整理并校正）',
  '题目描述': '给定 $n$ 个整数，求这些整数的总和。整理结果可以在应用前人工校正。',
  '输入格式': '第一行输入一个整数 $n$。\n第二行输入 $n$ 个整数，以空格分隔。',
  '输出格式': '输出这 $n$ 个整数的总和。',
  '测试样例': '### 样例输入\n```text\n3\n1 2 3\n```\n\n### 样例输出\n```text\n6\n```',
  '数据范围': '1 <= n <= 100000\n0 <= a_i <= 1000000000',
};

function completion(content, finishReason = 'stop') {
  return { id: 'mock-local-completion', object: 'chat.completion', model: updatedModel,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } };
}
function respond(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function writeSseEvent(response, payload) {
  if (response.destroyed || response.writableEnded) return false;
  const bytes = Buffer.from(`data: ${JSON.stringify(payload)}\r\n\r\n`, 'utf8');
  // Force UTF-8 Chinese glyphs across writes as well as SSE records across writes.
  const chinese = bytes.findIndex(value => value >= 0xe0);
  const split = chinese >= 0 ? chinese + 1 : Math.min(13, bytes.length - 1);
  response.write(bytes.subarray(0, split)); await pause(15);
  if (response.destroyed || response.writableEnded) return false;
  response.write(bytes.subarray(split)); return true;
}
async function streamingCompletion(response, call) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  response.flushHeaders();
  response.write(': acceptance keep-alive\n\n');
  await pause(350);
  if (!await writeSseEvent(response, { choices: [{ index: 0, delta: { reasoning_content: privateReasoning }, finish_reason: null }] })) return;
  await pause(300);
  for (let index = 0; index < aiResult.length; index += 45) {
    if (!await writeSseEvent(response, { choices: [{ index: 0, delta: { content: aiResult.slice(index, index + 45) }, finish_reason: null }] })) return;
    await pause(400);
  }
  if (!await writeSseEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })) return;
  if (!response.destroyed && !response.writableEnded) {
    call.completedResponse = true;
    response.end('data: [DONE]\n\n');
  }
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${fakeKey}`);
    assert.match(request.headers['content-type'] || '', /^application\/json/);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length; assert.ok(size < 1_000_000, 'Unexpectedly large outbound AI request'); chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.ok([initialModel, updatedModel].includes(body.model));
    assert.equal(body.stream, true);
    assert.ok(!Object.hasOwn(body, 'thinking'), 'Loopback OpenAI-compatible providers must not receive DeepSeek-only options');
    assert.ok(Array.isArray(body.messages) && body.messages.length >= 2);
    const user = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
    const kind = /连接测试助手/.test(body.messages.find(message => message.role === 'system')?.content || '') ? 'test' : 'organize';
    const call = { path: request.url, model: body.model, kind, scenario, user, stream: body.stream, authorizationValidated: true,
      receivedAt: Date.now(), closed: false, completedResponse: false };
    response.on('close', () => { call.closed = true; call.closedAt = Date.now(); pendingResponses.delete(response); });
    calls.push(call);
    for (const waiter of waiters.splice(0)) waiter();
    if (kind === 'test') { call.completedResponse = true; respond(response, 200, completion('连接成功')); return; }
    if (scenario === 'unauthorized') { respond(response, 401, { error: { message: 'Mock authorization failure', code: 'invalid_api_key' } }); return; }
    if (scenario === 'empty') { respond(response, 200, completion('')); return; }
    if (scenario === 'truncated') { respond(response, 200, completion('# 不完整的整理结果', 'length')); return; }
    if (scenario === 'unauthorized-hold') {
      response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); response.flushHeaders();
      response.write('{"error":{"message":"Mock held authorization body');
      pendingResponses.add(response); return;
    }
    if (scenario === 'hold') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }); response.flushHeaders();
      response.write(': keep alive while waiting\n\n');
      pendingResponses.add(response);
      return;
    }
    if (scenario === 'sse') { await streamingCompletion(response, call); return; }
    call.completedResponse = true;
    respond(response, 200, completion(aiResult));
  } catch (error) {
    mockFailures.push(error.message);
    respond(response, 500, { error: { message: 'Local acceptance mock rejected a request' } });
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

async function test(name, callback) {
  const start = Date.now();
  await callback();
  results.push({ name, status: 'PASS', elapsedMs: Date.now() - start });
  console.log(`PASS ${name}`);
}
async function launch() {
  const env = { ...process.env, DUIPAI_TEST_HIDDEN: '1', DUIPAI_DATA_DIR: data, DUIPAI_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [root], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'POST' || !['/api/ai/test', '/api/ai/organize'].includes(pathname)) return;
    try {
      const body = request.postDataJSON();
      if (body?.requestId) requestEntries.push({ id: body.requestId, operation: pathname.endsWith('/test') ? 'test' : 'organize', startedAt: Date.now() });
    } catch { /* Legacy no-body test calls may still be accepted by the backend. */ }
  });
  await page.getByText('本地服务已连接', { exact: true }).waitFor({ timeout: 30000 });
}
async function api(pathname, method = 'GET', body) {
  return page.evaluate(async ({ pathname, method, body }) => {
    const response = await fetch(`/api${pathname}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, value, text };
  }, { pathname, method, body });
}
async function settings() {
  const result = await api('/settings/ai');
  assert.equal(result.status, 200); assert.ok(!result.text.includes(fakeKey));
  assert.deepEqual(Object.keys(result.value).sort(), ['apiKeyConfigured', 'baseUrl', 'model']);
  return result.value;
}
async function openSettings() {
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 设置', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '保存配置', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('dialog[open] input[aria-label="API 地址"]');
    return input && !input.disabled;
  });
  return dialog;
}
async function closeSettings(dialog) {
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function openOrganizer() {
  await page.getByRole('button', { name: 'AI 整理题面', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理题面', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '开始整理', exact: true }).waitFor();
  return dialog;
}
async function closeOrganizer(dialog) {
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function readStatement() {
  if (!await page.getByLabel('Markdown 题面', { exact: true }).isVisible()) await page.getByRole('button', { name: '编辑', exact: true }).click();
  return page.getByLabel('Markdown 题面', { exact: true }).inputValue();
}
async function savedProblem() {
  await page.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 10000 });
  const result = await api(`/problems/${encodeURIComponent(problemId)}`);
  assert.equal(result.status, 200); return result.value;
}
async function assertUnchanged(expected = baseline) {
  assert.equal(await readStatement(), expected);
  assert.equal((await savedProblem()).statement, expected);
}
async function screenshot(file) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(png, 'base64'));
}
async function waitForCall(after) {
  if (calls.length > after) return calls[calls.length - 1];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The configured local AI server received no request')), 10000);
    waiters.push(() => { clearTimeout(timer); resolve(); });
  });
  return calls[calls.length - 1];
}
async function waitUntil(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await pause(100); }
  throw new Error(message);
}
async function snapshot(id) {
  const result = await api(`/ai/requests/${encodeURIComponent(id)}`);
  assert.equal(result.status, 200, result.text); return result.value;
}
async function latestRequest(after) {
  const entry = await waitUntil(() => requestEntries.length > after && requestEntries.at(-1), 'AI requestId was not attached to the frontend request');
  assert.match(entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return entry;
}
async function showProcessingRecord(dialog, id) {
  await dialog.getByText('处理记录', { exact: true }).click();
  await dialog.getByLabel('AI 处理记录', { exact: true }).waitFor();
  assert.ok((await dialog.innerText()).includes(id), 'The visible processing record must identify the real backend request');
  assert.doesNotMatch(await dialog.innerText(), /PRIVATE_REASONING_SENTINEL/);
}
async function startOrganizing(dialog) {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/organize' && response.request().method() === 'POST', { timeout: 30000 });
  await dialog.getByRole('button', { name: '开始整理', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  await dialog.getByLabel('题目描述', { exact: true }).waitFor();
  return response.json();
}
function assertPrivateContentAbsent(call) {
  assert.equal(call.kind, 'organize');
  assert.doesNotMatch(call.user, /\/api\/images\/|data:image\/|PRIVATE_IMAGE_ALT|PRIVATE_NOTE_SENTINEL|UNKNOWN_METADATA_SENTINEL|JAVA_EDITOR_SENTINEL/);
  assert.match(call.user, /1 2 3/); assert.match(call.user, /100000/);
  assert.ok(!call.user.includes(fakeKey));
}

try {
  await launch();
  await page.getByRole('button', { name: '新建题目', exact: true }).click();
  await page.getByLabel('题目标题', { exact: true }).fill('AI 整理题面验收');
  await page.getByRole('button', { name: '创建题目', exact: true }).click();
  await page.getByRole('button', { name: 'AI 设置', exact: true }).waitFor();
  const listed = await api('/problems'); problemId = listed.value[0].id;
  await test('AI 设置保存和 GET 不回显密钥，Windows DPAPI 加密存储', async () => {
    assert.equal((await settings()).apiKeyConfigured, false);
    const dialog = await openSettings(), before = calls.length;
    await dialog.getByLabel('API 地址', { exact: true }).fill(`${baseUrl}/`);
    await dialog.getByLabel('模型名称', { exact: true }).fill(initialModel);
    await dialog.getByLabel('API Key', { exact: true }).fill(fakeKey);
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
    await dialog.getByText('AI 配置已保存。', { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('API Key', { exact: true }).inputValue(), '');
    assert.equal(calls.length, before, 'Saving configuration must not contact the AI provider');
    assert.deepEqual(await settings(), { baseUrl, model: initialModel, apiKeyConfigured: true });
    const storage = await readFile(path.join(data, 'ai-settings.json'), 'utf8');
    assert.ok(!storage.includes(fakeKey));
    assert.match(JSON.parse(storage).encryptedApiKey, /^dpapi:v1:/);
    await closeSettings(dialog);
  });
  await test('保存并测试通过本地 OpenAI 兼容路径、认证头和配置模型', async () => {
    const dialog = await openSettings(), before = calls.length;
    assert.equal(await dialog.getByLabel('API Key', { exact: true }).inputValue(), '');
    await dialog.getByRole('button', { name: '保存并测试', exact: true }).click();
    const call = await waitForCall(before);
    await dialog.locator('.ai-settings-status').filter({ hasText: /连接成功/ }).waitFor();
    assert.equal(call.kind, 'test'); assert.equal(call.path, '/v1/chat/completions');
    assert.equal(call.model, initialModel); assert.equal(call.authorizationValidated, true); assert.equal(call.stream, true);
    assert.match(call.user, /连接成功/);
    await closeSettings(dialog);
  });
  await test('留空密钥编辑配置保留原 Key，新的模型用于连接测试', async () => {
    const dialog = await openSettings(), before = calls.length;
    await dialog.getByLabel('模型名称', { exact: true }).fill(updatedModel);
    await dialog.getByRole('button', { name: '保存并测试', exact: true }).click();
    const call = await waitForCall(before);
    await dialog.locator('.ai-settings-status').filter({ hasText: /连接成功/ }).waitFor();
    assert.equal(call.model, updatedModel); assert.equal((await settings()).apiKeyConfigured, true);
    await closeSettings(dialog);
  });

  const uploaded = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 420; canvas.height = 180;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 420, 180);
    context.fillStyle = '#111'; context.font = '26px sans-serif'; context.fillText('AI acceptance image', 30, 90);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const form = new FormData(); form.append('file', blob, 'AI 测试题图.png');
    const response = await fetch('/api/images', { method: 'POST', body: form });
    if (!response.ok) throw new Error(`Fixture image upload failed: ${response.status}`);
    return response.json();
  });
  originalImage = `![PRIVATE_IMAGE_ALT](${uploaded.url})`;
  baseline = `# 原始数组求和\n\n## 题目描述\n给 定 n 个 整 数，求 这 些 整 数 的 总 和。\n${originalImage}\n\n## 输入格式\n第 一 行 是 n。\n第 二 行 是 n 个 整 数。\n\n## 输出格式\n输 出 总 和。\n\n## 测试样例\n### 样例输入\n\`\`\`text\n3\n1 2 3\n\`\`\`\n\n### 样例输出\n\`\`\`text\n6\n\`\`\`\n\n## 数据范围\n1 <= n <= 100000\n0 <= a_i <= 1000000000\n\n${privateNote}\n\n${unknownSection}`;
  const problem = (await api(`/problems/${problemId}`)).value;
  problem.statement = baseline;
  for (const role of Object.keys(problem.codes)) problem.codes[role] = `// JAVA_EDITOR_SENTINEL_${role}\n${problem.codes[role]}`;
  assert.equal((await api(`/problems/${problemId}`, 'PUT', problem)).status, 200);
  baselineCodes = problem.codes;
  await page.reload(); await page.getByText('本地服务已连接', { exact: true }).waitFor();
  await assertUnchanged();

  await test('识别草稿内 AI 仅发送勾选区域，取消不改题面，更新后保留原图标记并可应用撤销', async () => {
    const draftLines = ['题目标题: 草稿数组求和', '题目描述', '识别草稿中的描述等待 AI 整理。', '输入格式',
      '第一行输入 n，第二行输入 n 个整数。', '输出格式', '输出所有整数的总和。', '样例输入', '3', '1 2 3',
      '样例输出', '6', '数据范围', '5 <= n <= 77777'];
    const recognized = { width: 420, height: 180, language: 'zh-Hans-CN',
      lines: draftLines.map((text, index) => ({ text, x: 20, y: 8 + index * 11, width: Math.min(360, text.length * 9), height: 8 })) };
    const statusHandler = route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ available: true, languages: [{ tag: 'zh-Hans-CN', name: '简体中文（验收 mock）' }], message: '本地验收 mock 识别' }) });
    const recognitionHandler = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recognized) });
    await page.route('**/api/images/recognition/status', statusHandler);
    await page.route('**/api/images/*/recognize', recognitionHandler);
    try {
      await page.getByRole('button', { name: '识别图片题目', exact: true }).click();
      const outer = page.getByRole('dialog', { name: '识别图片题目', exact: true }); await outer.waitFor();
      await outer.getByRole('button', { name: '开始识别', exact: true }).click();
      await outer.getByLabel('题目描述', { exact: true }).waitFor();
      const originalDraft = await outer.getByLabel('题目描述', { exact: true }).inputValue();
      const originalDescriptionRegions = await outer.locator('.recognition-region.kind-description').count();
      const originalSampleRegions = await outer.locator('.recognition-region.kind-samples').count();
      assert.ok(originalDescriptionRegions > 0 && originalSampleRegions > 0);
      await outer.getByRole('checkbox', { name: '应用数据范围', exact: true }).uncheck();
      await outer.getByRole('button', { name: 'AI 整理识别结果', exact: true }).click();
      let nested = page.getByRole('dialog', { name: 'AI 整理题面', exact: true }); await nested.waitFor();
      const source = await nested.getByLabel('发送给 AI 的题面文字', { exact: true }).inputValue();
      assert.ok(source.includes(originalDraft)); assert.doesNotMatch(source, /77777|PRIVATE_IMAGE_ALT|PRIVATE_NOTE_SENTINEL/);
      const firstCall = calls.length; await startOrganizing(nested);
      assert.doesNotMatch(calls[firstCall].user, /77777|\/api\/images\/|PRIVATE_NOTE_SENTINEL|JAVA_EDITOR_SENTINEL/);
      assert.match(calls[firstCall].user, /1 2 3/);
      await nested.getByLabel('题目描述', { exact: true }).fill('取消的 AI 草稿不能覆盖识别结果。');
      await nested.getByRole('button', { name: '取消', exact: true }).click(); await nested.waitFor({ state: 'hidden' });
      assert.equal(await outer.getByLabel('题目描述', { exact: true }).inputValue(), originalDraft);
      assert.equal((await savedProblem()).statement, baseline);

      await outer.getByRole('button', { name: 'AI 整理识别结果', exact: true }).click();
      nested = page.getByRole('dialog', { name: 'AI 整理题面', exact: true }); await nested.waitFor();
      await startOrganizing(nested);
      const correctedDraft = 'OCR 草稿中的 AI 整理结果已核对，等待外层确认。';
      await nested.getByLabel('题目描述', { exact: true }).fill(correctedDraft);
      await nested.getByRole('checkbox', { name: '应用数据范围', exact: true }).uncheck();
      await nested.getByRole('button', { name: '更新识别草稿', exact: true }).click(); await nested.waitFor({ state: 'hidden' });
      assert.equal(await outer.getByLabel('题目描述', { exact: true }).inputValue(), correctedDraft);
      assert.match(await outer.getByLabel('数据范围', { exact: true }).inputValue(), /77777/);
      assert.ok(!await outer.getByRole('checkbox', { name: '应用数据范围', exact: true }).isChecked());
      assert.equal(await outer.locator('.recognition-region.kind-description').count(), originalDescriptionRegions);
      assert.equal(await outer.locator('.recognition-region.kind-samples').count(), originalSampleRegions);
      const mappedBoxes = await outer.locator('.recognition-region').evaluateAll(elements => elements.map(element => {
        const rectangle = element.getBoundingClientRect(); return { width: rectangle.width, height: rectangle.height };
      }));
      assert.ok(mappedBoxes.length >= 5 && mappedBoxes.every(box => box.width > 0 && box.height > 0));
      assert.equal((await savedProblem()).statement, baseline, 'Updating the OCR draft must not save the problem before the outer apply');
      await outer.getByRole('button', { name: '应用到题面', exact: true }).click(); await outer.waitFor({ state: 'hidden' });
      const updated = await readStatement(); assert.ok(updated.includes(correctedDraft));
      assert.ok(updated.includes(originalImage) && updated.includes(privateNote) && updated.includes(unknownSection));
      assert.ok(updated.includes('1 <= n <= 100000') && !updated.includes('77777'), 'The original problem range must remain when the OCR draft range is unchecked');
      assert.equal((await savedProblem()).statement, updated);
      await page.getByRole('button', { name: '撤销识别替换', exact: true }).click(); await assertUnchanged();
    } finally {
      await page.unroute('**/api/images/recognition/status', statusHandler);
      await page.unroute('**/api/images/*/recognize', recognitionHandler);
    }
  });

  await test('打开 AI 整理仅展示待发送文字，图片、个人笔记和程序不会发送', async () => {
    const before = calls.length, dialog = await openOrganizer();
    const source = await dialog.getByLabel('发送给 AI 的题面文字', { exact: true }).inputValue();
    assert.doesNotMatch(source, /\/api\/images\/|PRIVATE_IMAGE_ALT|PRIVATE_NOTE_SENTINEL|UNKNOWN_METADATA_SENTINEL|JAVA_EDITOR_SENTINEL/);
    assert.match(source, /1 2 3/); assert.match(source, /100000/);
    assert.equal(calls.length, before, 'Opening the review dialog must not send any AI request');
    assert.ok(!await dialog.getByRole('button', { name: '应用到题面', exact: true }).isEnabled());
    await closeOrganizer(dialog); await assertUnchanged();
  });
  await test('取消进行中的真实请求不写入题面并可再次整理', async () => {
    scenario = 'hold'; const dialog = await openOrganizer(), before = calls.length, beforeRequests = requestEntries.length;
    await dialog.getByRole('button', { name: '开始整理', exact: true }).click();
    const heldCall = await waitForCall(before); assertPrivateContentAbsent(heldCall);
    const request = await latestRequest(beforeRequests);
    const cancellationStarted = Date.now();
    const cancellationResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/ai/requests/${request.id}/cancel` && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '取消整理', exact: true }).click();
    assert.equal((await cancellationResponse).status(), 200);
    await dialog.locator('.recognition-footer [role="status"]').filter({ hasText: /已取消 AI 整理/ }).waitFor();
    await waitUntil(() => heldCall.closed && !heldCall.completedResponse, 'Cancelling must close the held upstream SSE response', 5000);
    assert.ok(Date.now() - cancellationStarted < 5000, 'Cancellation must release the upstream request promptly');
    assert.equal((await snapshot(request.id)).state, 'CANCELLED');
    assert.ok(await dialog.getByRole('button', { name: '开始整理', exact: true }).isEnabled());
    assert.equal((await savedProblem()).statement, baseline);
    scenario = 'success'; const retryStarted = Date.now(), retryEntries = requestEntries.length;
    await startOrganizing(dialog);
    assert.ok(Date.now() - retryStarted < 7000, 'The cancelled request must allow a quick retry instead of leaving the provider slot occupied');
    assert.notEqual((await latestRequest(retryEntries)).id, request.id);
    await closeOrganizer(dialog); await assertUnchanged();
  });
  for (const [errorScenario, label] of [['unauthorized', 'HTTP 认证错误'], ['empty', '空内容'], ['truncated', '截断内容']]) {
    await test(`AI 服务${label}有明确错误且不覆盖题面`, async () => {
      scenario = errorScenario; const dialog = await openOrganizer();
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/organize', { timeout: 30000 });
      await dialog.getByRole('button', { name: '开始整理', exact: true }).click();
      const response = await responsePromise; assert.equal(response.status(), 502, await response.text());
      await dialog.getByRole('alert').waitFor();
      const message = await dialog.getByRole('alert').innerText();
      assert.ok(message.length > 5); assert.ok(!message.includes(fakeKey));
      assert.ok(!await dialog.getByRole('button', { name: '应用到题面', exact: true }).isEnabled());
      scenario = 'success'; await closeOrganizer(dialog); await assertUnchanged();
    });
  }
  await test('真正 SSE 中文跨分块接收显示实时进度和成功处理记录，完整结果前不可应用', async () => {
    scenario = 'sse'; const dialog = await openOrganizer(), before = calls.length, beforeRequests = requestEntries.length;
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/organize' && response.request().method() === 'POST', { timeout: 30000 });
    await dialog.getByRole('button', { name: '开始整理', exact: true }).click();
    const call = await waitForCall(before); assertPrivateContentAbsent(call);
    const request = await latestRequest(beforeRequests); diagnosticSuccessId = request.id;
    const progress = await waitUntil(async () => {
      const value = await snapshot(request.id);
      return value.state === 'RUNNING' && value.receivedCharacters > 0 && value.receivedCharacters < aiResult.length && value;
    }, 'The SSE response must expose real partial content progress before completion');
    assert.equal(progress.httpStatus, 200); assert.equal(progress.thinkingDisabled, false);
    assert.ok(progress.firstResponseMs >= 250 && progress.firstResponseMs <= progress.elapsedMs);
    assert.equal(progress.reasoningCharacters, privateReasoning.length);
    const visibleStatus = dialog.getByLabel('AI 处理状态', { exact: true }); await visibleStatus.waitFor();
    await waitUntil(async () => /已接收 [1-9]\d* 字符/.test(await visibleStatus.innerText()), 'The live UI must show received character progress');
    const statusText = await visibleStatus.innerText();
    assert.match(statusText, /已耗时 [\d.]+ 秒/); assert.match(statusText, /首响应 [\d.]+ 秒/);
    assert.match(statusText, /思考字符 \d+/);
    assert.ok(!await dialog.getByRole('button', { name: '应用到题面', exact: true }).isEnabled());
    assert.equal((await savedProblem()).statement, baseline);
    assert.doesNotMatch(await dialog.innerText(), /PRIVATE_REASONING_SENTINEL/);
    const response = await responsePromise; assert.equal(response.status(), 200, await response.text());
    assert.equal((await response.json()).statement, aiResult, 'Chunked UTF-8 streaming must preserve the exact final Markdown');
    await dialog.getByLabel('题目描述', { exact: true }).waitFor();
    const complete = await snapshot(request.id);
    assert.equal(complete.state, 'SUCCEEDED'); assert.equal(complete.stage, 'completed');
    assert.equal(complete.receivedCharacters, aiResult.length); assert.equal(complete.reasoningCharacters, privateReasoning.length);
    assert.ok(complete.logs.some(log => /HTTP 200/.test(log.message)));
    assert.ok(complete.logs.some(log => /请求完成/.test(log.message)));
    assert.doesNotMatch(JSON.stringify(complete), /PRIVATE_REASONING_SENTINEL|数组求和/);
    await showProcessingRecord(dialog, request.id);
    assert.match(await dialog.getByLabel('AI 处理记录', { exact: true }).innerText(), /HTTP 200|请求完成/);
    await dialog.getByLabel('测试样例', { exact: true }).scrollIntoViewIfNeeded();
    await screenshot(path.join(root, 'docs', 'ai-preview.png'));
    await closeOrganizer(dialog); scenario = 'success'; await assertUnchanged();
  });
  await test('401 响应仅收到头部也及时失败并关闭上游，失败处理记录可查看', async () => {
    scenario = 'unauthorized-hold'; const dialog = await openOrganizer(), before = calls.length, beforeRequests = requestEntries.length;
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/organize', { timeout: 7000 });
    const started = Date.now(); await dialog.getByRole('button', { name: '开始整理', exact: true }).click();
    const call = await waitForCall(before), request = await latestRequest(beforeRequests); diagnosticFailureId = request.id;
    const response = await responsePromise; assert.equal(response.status(), 502, await response.text());
    assert.ok(Date.now() - started < 5000, 'A held HTTP 401 body must not delay the error until the overall timeout');
    await waitUntil(() => call.closed && !call.completedResponse, 'An HTTP 401 response must close the held upstream body', 5000);
    await dialog.getByRole('alert').waitFor(); assert.match(await dialog.getByRole('alert').innerText(), /API Key|认证|授权/);
    assert.ok(!await dialog.getByRole('button', { name: '应用到题面', exact: true }).isEnabled());
    const failed = await snapshot(request.id); assert.equal(failed.state, 'FAILED'); assert.equal(failed.stage, 'failed'); assert.equal(failed.httpStatus, 401);
    assert.ok(failed.elapsedMs < 5000); assert.ok(failed.logs.some(log => log.level === 'error'));
    await showProcessingRecord(dialog, request.id); assert.match(await dialog.getByLabel('AI 处理记录', { exact: true }).innerText(), /HTTP 401/);
    await closeOrganizer(dialog); scenario = 'success'; await assertUnchanged();
  });
  await test('重新整理失败后旧草稿不能应用，源题面持续保持不变', async () => {
    const dialog = await openOrganizer(); await startOrganizing(dialog);
    assert.ok(await dialog.getByRole('button', { name: '应用到题面', exact: true }).isEnabled());
    scenario = 'empty'; const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai/organize');
    await dialog.getByRole('button', { name: '重新整理', exact: true }).click();
    assert.ok(!await dialog.getByRole('button', { name: '应用到题面', exact: true }).isEnabled());
    assert.equal((await responsePromise).status(), 502); await dialog.getByRole('alert').waitFor();
    assert.ok(!await dialog.getByRole('button', { name: '应用到题面', exact: true }).isEnabled());
    assert.equal(await dialog.getByLabel('题目描述', { exact: true }).count(), 0, 'An old successful result must not remain as an applicable draft after retry failure');
    scenario = 'success'; await closeOrganizer(dialog); await assertUnchanged();
  });
  await test('处理日志含编号、HTTP 和耗时且无密钥题面推理，后台日志按钮定位本次隔离文件', async () => {
    const log = await waitUntil(async () => {
      const text = await readFile(path.join(data, 'backend.log'), 'utf8');
      return text.includes(diagnosticSuccessId) && text.includes(diagnosticFailureId) && text;
    }, 'The backend log must persist AI request metadata');
    assert.match(log, /elapsedMs=\d+/); assert.match(log, /httpStatus=200/); assert.match(log, /httpStatus=401/);
    assert.ok(!log.includes(fakeKey)); assert.doesNotMatch(log, /PRIVATE_REASONING_SENTINEL|PRIVATE_NOTE_SENTINEL|PRIVATE_IMAGE_ALT|UNKNOWN_METADATA_SENTINEL|JAVA_EDITOR_SENTINEL|数组求和|所有整数的总和/);
    await app.evaluate(({ shell }) => {
      globalThis.__aiLogPaths = []; globalThis.__aiOriginalOpenPath = shell.openPath;
      shell.openPath = async file => { globalThis.__aiLogPaths.push(file); return ''; };
    });
    try {
      const dialog = await openOrganizer(); await startOrganizing(dialog);
      await showProcessingRecord(dialog, requestEntries.at(-1).id);
      await dialog.getByRole('button', { name: '查看后台日志', exact: true }).click();
      const paths = await waitUntil(() => app.evaluate(() => globalThis.__aiLogPaths.length && globalThis.__aiLogPaths), 'The backend log button must invoke the trusted Electron IPC');
      assert.deepEqual(paths.map(file => path.resolve(file)), [path.resolve(data, 'backend.log')]);
      const info = await page.evaluate(() => window.duipai.getInfo());
      assert.equal(path.resolve(info.logPath), path.resolve(data, 'backend.log'));
      await closeOrganizer(dialog); await assertUnchanged();
    } finally {
      await app.evaluate(({ shell }) => { shell.openPath = globalThis.__aiOriginalOpenPath; delete globalThis.__aiOriginalOpenPath; });
    }
  });
  await test('AI 返回 Markdown 段落、格式、测试样例与范围可逐区编辑，确认前不保存', async () => {
    const dialog = await openOrganizer(), before = calls.length;
    const response = await startOrganizing(dialog);
    assert.equal(response.statement, aiResult); assertPrivateContentAbsent(calls[before]);
    assert.match(await dialog.getByLabel('题目标题', { exact: true }).inputValue(), /数组求和/);
    assert.match(await dialog.getByLabel('题目描述', { exact: true }).inputValue(), /整数/);
    assert.match(await dialog.getByLabel('输入格式', { exact: true }).inputValue(), /第一行/);
    assert.match(await dialog.getByLabel('输出格式', { exact: true }).inputValue(), /总和/);
    assert.match(await dialog.getByLabel('测试样例', { exact: true }).inputValue(), /1 2 3[\s\S]*6/);
    assert.match(await dialog.getByLabel('数据范围', { exact: true }).inputValue(), /100000/);
    for (const [label, content] of Object.entries(corrections)) await dialog.getByLabel(label, { exact: true }).fill(content);
    await dialog.getByLabel('测试样例', { exact: true }).scrollIntoViewIfNeeded();
    assert.equal((await savedProblem()).statement, baseline);
    await closeOrganizer(dialog); await assertUnchanged();
  });
  await test('选择应用区域可保留原范围，应用后自动保存且可撤销', async () => {
    const dialog = await openOrganizer(); await startOrganizing(dialog);
    await dialog.getByLabel('题目描述', { exact: true }).fill(corrections['题目描述']);
    await dialog.getByLabel('数据范围', { exact: true }).fill('999 <= n <= 999999');
    await dialog.getByRole('checkbox', { name: '应用数据范围', exact: true }).uncheck();
    await dialog.getByRole('button', { name: '应用到题面', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const partial = await readStatement(); assert.ok(partial.includes(corrections['题目描述']));
    assert.ok(partial.includes('1 <= n <= 100000')); assert.ok(!partial.includes('999 <= n'));
    assert.equal((await savedProblem()).statement, partial);
    await page.getByRole('button', { name: '撤销识别替换', exact: true }).click();
    await assertUnchanged();
  });
  await test('确认后替换各文字区域，保留原图和个人、自定义内容及全部程序', async () => {
    const dialog = await openOrganizer(); await startOrganizing(dialog);
    for (const [label, content] of Object.entries(corrections)) await dialog.getByLabel(label, { exact: true }).fill(content);
    await dialog.getByRole('button', { name: '应用到题面', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    applied = await readStatement();
    for (const content of Object.values(corrections)) assert.ok(applied.includes(content), `Corrected section missing: ${content}`);
    assert.ok(applied.includes(originalImage)); assert.ok(applied.includes(privateNote)); assert.ok(applied.includes(unknownSection));
    assert.doesNotMatch(applied, /原始数组求和|给 定 n 个 整 数/);
    for (const heading of ['题目描述', '输入格式', '输出格式', '测试样例', '数据范围'])
      assert.equal((applied.match(new RegExp(`^## ${heading}$`, 'gm')) || []).length, 1, `Duplicate section: ${heading}`);
    const saved = await savedProblem(); assert.equal(saved.statement, applied); assert.deepEqual(saved.codes, baselineCodes);
  });
  await test('重启后题面、图像和密钥配置恢复，Key 仍不回显并可测试连接', async () => {
    await savedProblem(); await app.close(); app = null; await launch();
    await assertUnchanged(applied);
    assert.deepEqual(await settings(), { baseUrl, model: updatedModel, apiKeyConfigured: true });
    const dialog = await openSettings(), before = calls.length;
    assert.equal(await dialog.getByLabel('API Key', { exact: true }).inputValue(), '');
    await dialog.getByRole('button', { name: '保存并测试', exact: true }).click();
    await waitForCall(before); await dialog.locator('.ai-settings-status').filter({ hasText: /连接成功/ }).waitFor();
    await closeSettings(dialog);
    const image = await api(uploaded.url.replace(/^\/api/, ''));
    assert.equal(image.status, 200);
    assert.deepEqual((await savedProblem()).codes, baselineCodes);
  });
  await test('可显式清除 API Key，连接失败不会外发请求，重启后继续保持清除', async () => {
    const dialog = await openSettings(), before = calls.length;
    await dialog.getByRole('checkbox', { name: '清除已保存的 API Key', exact: true }).check();
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
    await dialog.getByText('AI 配置已保存。', { exact: true }).waitFor();
    assert.equal((await settings()).apiKeyConfigured, false);
    const testResponse = await api('/ai/test', 'POST'); assert.equal(testResponse.status, 400); assert.match(testResponse.value.message, /API Key/);
    assert.equal(calls.length, before, 'A cleared API key must prevent outbound AI requests');
    assert.equal(JSON.parse(await readFile(path.join(data, 'ai-settings.json'), 'utf8')).encryptedApiKey, null);
    await closeSettings(dialog); await app.close(); app = null; await launch();
    assert.equal((await settings()).apiKeyConfigured, false); await assertUnchanged(applied);
    assert.deepEqual(pageErrors, []); assert.deepEqual(mockFailures, []);
    const log = await readFile(path.join(data, 'backend.log'), 'utf8'); assert.ok(!log.includes(fakeKey));
  });
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const summary = { date: new Date().toISOString(), version, fixture: directory, provider: 'Local loopback mock; fake key only',
    requestCount: calls.length, requests: calls.map(({ user, ...call }) => ({ ...call, userCharacterCount: user.length })),
    diagnosticRequestIds: { success: diagnosticSuccessId, failure: diagnosticFailureId }, results };
  await writeFile(path.join(root, 'docs', 'ai-results.json'), JSON.stringify(summary, null, 2));
  console.log(`${results.length} 项 AI 整理验收通过；全部请求仅发往本机 mock。`);
} catch (error) {
  if (page && !page.isClosed()) {
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-2500));
    await screenshot(path.join(directory, 'failure.png')).catch(() => {});
  }
  throw error;
} finally {
  for (const response of pendingResponses) response.destroy();
  if (app) await app.close().catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
