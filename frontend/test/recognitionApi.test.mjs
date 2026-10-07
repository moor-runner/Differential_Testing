import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';
import { statementImages } from '../src/statementImages.ts';

const url = '/api/images/12345678-1234-1234-1234-123456789abc.png';
test('recognition only sends local uploaded filenames to the backend', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    calls++;
    assert.equal(target, `${url}/recognize`);
    assert.deepEqual(JSON.parse(options.body), { language: 'zh-Hans-CN' });
    return new Response(JSON.stringify({ width: 800, height: 600, language: 'zh-Hans-CN', lines: [] }));
  });
  assert.equal((await api.recognizeImage(url, 'zh-Hans-CN')).url, url);
  for (const bad of ['https://example.com/image.png', '/api/images/../../outside.png', '/api/images/image.png']) await assert.rejects(api.recognizeImage(bad), /本地图片/);
  assert.equal(calls, 1);
});
test('recognition cancellation aborts the in-flight request and reports cancellation', async t => {
  t.mock.method(globalThis, 'fetch', async (_target, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const operation = api.recognizeImage(url, '', controller.signal);
  controller.abort();
  await assert.rejects(operation, /已取消图片识别/);
});
test('recognition timeout releases the request with actionable error', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => timeout(10));
  t.mock.method(globalThis, 'fetch', async (_target, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(api.recognizeImage(url), /图片识别超时/); }
  finally { clearInterval(keepAlive); }
});
test('recognition retains the Windows language setup error returned by the service', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: '请安装中文 OCR 语言包' }), { status: 503 }));
  await assert.rejects(api.recognizeImage(url), /中文 OCR 语言包/);
});
test('image selection preserves document order, deduplicates and ignores remote images and fenced examples', () => {
  const other = '/api/images/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
  const markdown = `![第一张](${url})\n![重复](${url})\n![远程](https://example.com/image.png)\n\n~~~markdown\n![示例](${other})\n~~~\n\n![第二张][b]\n\n[b]: ${other}`;
  assert.deepEqual(statementImages(markdown), [{ url, alt: '第一张' }, { url: other, alt: '第二张' }]);
});
