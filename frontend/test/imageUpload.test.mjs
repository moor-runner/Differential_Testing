import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';

const file = () => new File([new Uint8Array([1])], 'image.png', { type: 'image/png' });
test('hung image upload times out with a readable error', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => timeout(10));
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(api.upload(file()), /图片保存超时/); }
  finally { clearInterval(keepAlive); }
});
test('user cancellation aborts the actual request', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const operation = api.upload(file(), controller.signal);
  controller.abort();
  await assert.rejects(operation, /已取消插入图片/);
});
test('image upload preserves backend validation errors', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: '图片像素总量须不超过 1600 万' }), { status: 400 }));
  await assert.rejects(api.upload(file()), /1600 万/);
});
