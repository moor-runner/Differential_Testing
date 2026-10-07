import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';

test('AI configuration is read locally and saving does not test the external service', async t => {
  const calls = [];
  const settings = { baseUrl: 'https://provider.example/v1', model: 'sample-model', apiKeyConfigured: true };
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    calls.push({ target, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    return new Response(JSON.stringify(settings));
  });
  assert.deepEqual(await api.aiSettings(), settings);
  await api.saveAiSettings({ baseUrl: settings.baseUrl, model: settings.model });
  await api.saveAiSettings({ baseUrl: settings.baseUrl, model: settings.model, clearApiKey: true });
  assert.deepEqual(calls, [
    { target: '/api/settings/ai', method: undefined, body: undefined },
    { target: '/api/settings/ai', method: 'PUT', body: { baseUrl: settings.baseUrl, model: settings.model } },
    { target: '/api/settings/ai', method: 'PUT', body: { baseUrl: settings.baseUrl, model: settings.model, clearApiKey: true } },
  ]);
});

test('AI organization sends only the provided statement and connection testing is a separate explicit request', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    calls.push({ target, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    return new Response(JSON.stringify(target.endsWith('/test') ? { message: '连接成功', model: 'sample-model' } : { statement: '# 整理后的题目' }));
  });
  assert.equal((await api.organizeStatement('# 原始题面')).statement, '# 整理后的题目');
  assert.equal((await api.testAiConnection()).message, '连接成功');
  assert.deepEqual(calls, [
    { target: '/api/ai/organize', method: 'POST', body: { statement: '# 原始题面' } },
    { target: '/api/ai/test', method: 'POST', body: undefined },
  ]);
});

test('AI cancellation aborts the actual request and preserves the cancellation message', async t => {
  t.mock.method(globalThis, 'fetch', async (_target, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  for (const [start, message] of [[signal => api.organizeStatement('# 题目', signal), /已取消 AI 整理/], [signal => api.testAiConnection(signal), /已取消连接测试/]]) {
    const controller = new AbortController();
    const operation = start(controller.signal);
    controller.abort();
    await assert.rejects(operation, message);
  }
});

test('AI timeout is longer than local backend generation and gives an actionable error', async t => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 150000);
    return nativeTimeout(10);
  });
  t.mock.method(globalThis, 'fetch', async (_target, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(api.organizeStatement('# 题目'), /AI 整理超时/); }
  finally { clearInterval(keepAlive); }
});

test('AI wrappers retain provider-facing errors returned safely by the local service', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'API Key 无效，请检查配置。' }), { status: 400 }));
  await assert.rejects(api.organizeStatement('# 题目'), /API Key 无效/);
});
