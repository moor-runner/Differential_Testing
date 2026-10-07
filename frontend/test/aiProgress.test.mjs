import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = value => new Response(JSON.stringify(value));
const snapshot = (id, overrides = {}) => ({ id, operation: 'organize', state: 'RUNNING', stage: 'RECEIVING', message: '正在接收 AI 响应', elapsedMs: 600, firstResponseMs: 250, receivedCharacters: 12, reasoningCharacters: 4, httpStatus: 200, thinkingDisabled: true, logs: [{ elapsedMs: 0, level: 'info', message: '已发送请求' }, { elapsedMs: 250, level: 'info', message: '收到首个响应' }], ...overrides });
async function waitFor(predicate) { for (let index = 0; index < 200; index++) { if (predicate()) return; await delay(10); } throw new Error('mock operation did not reach its expected stage'); }

test('AI progress observes delayed response before completion, ignores startup 404 and stops polling afterward', async t => {
  const result = deferred(); const updates = []; let requestId; let getCalls = 0; let inFlight = 0; let maxInFlight = 0; let completed = false;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (target === '/api/ai/organize') { const body = JSON.parse(options.body); requestId = body.requestId; assert.equal(body.statement, '# 原题面'); return result.promise; }
    assert.match(target, /^\/api\/ai\/requests\/[0-9a-f-]+$/);
    getCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (getCalls === 1) return new Response(JSON.stringify({ message: '尚未开始' }), { status: 404 });
      await delay(30);
      return response(snapshot(requestId, completed ? { state: 'SUCCEEDED', stage: 'DONE', message: '整理完成' } : {}));
    } finally { inFlight--; }
  });
  const operation = api.organizeStatement('# 原题面', undefined, value => updates.push(value));
  await waitFor(() => updates.some(value => value.state === 'RUNNING'));
  assert.match(requestId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(updates.some(value => value.notice), false);
  assert.equal(updates.find(value => value.state === 'RUNNING').receivedCharacters, 12);
  completed = true; result.resolve(response({ statement: '# 整理完成' }));
  assert.equal((await operation).statement, '# 整理完成');
  assert.equal(updates.at(-1).state, 'SUCCEEDED'); assert.equal(maxInFlight, 1);
  const callsAtCompletion = getCalls; await delay(30); assert.equal(getCalls, callsAtCompletion);
});

test('failed status reads produce visible diagnostics without inventing provider progress or erasing a valid result', async t => {
  const result = deferred(); const updates = [];
  t.mock.method(globalThis, 'fetch', async target => target === '/api/ai/organize' ? result.promise : new Response(JSON.stringify({ message: '暂时不可用' }), { status: 500 }));
  const operation = api.organizeStatement('# 原题面', undefined, value => updates.push(value));
  await waitFor(() => updates.some(value => value.notice));
  result.resolve(response({ statement: '# 整理完成' })); await operation;
  assert.ok(updates.every(value => value.notice));
  assert.match(updates[0].message, /HTTP 500/); assert.match(updates.at(-1).message, /最后处理状态读取失败/);
});

test('cancellation sends the independent backend cancel request immediately and rejects a late successful body', async t => {
  const result = deferred(); const updates = []; let requestId; let cancelCalls = 0;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (target === '/api/ai/organize') { requestId = JSON.parse(options.body).requestId; return result.promise; }
    if (target.endsWith('/cancel')) { cancelCalls++; assert.equal(options.method, 'POST'); assert.equal(options.signal.aborted, false); return response(snapshot(requestId, { state: 'CANCELLED', stage: 'CANCELLED', message: '请求已取消' })); }
    const id = target.split('/').at(-1); await delay(150); return response(snapshot(id));
  });
  const controller = new AbortController();
  const operation = api.organizeStatement('# 原题面', controller.signal, value => updates.push(value));
  await waitFor(() => !!requestId); controller.abort();
  await waitFor(() => cancelCalls === 1 && updates.some(value => value.state === 'CANCELLED'));
  result.resolve(response({ statement: '# 不应应用的迟到结果' }));
  await assert.rejects(operation, /已取消 AI 整理/);
  assert.equal(cancelCalls, 1); assert.equal(updates.at(-1).state, 'CANCELLED');
  assert.equal(updates.some(value => value.state === 'RUNNING'), false);
});

test('the frontend deadline truly cancels a tracked backend request instead of just hiding its spinner', async t => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal); const updates = []; let requestId; let cancelCalls = 0;
  t.mock.method(AbortSignal, 'timeout', milliseconds => nativeTimeout(milliseconds === 150000 ? 15 : milliseconds));
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (target === '/api/ai/organize') {
      requestId = JSON.parse(options.body).requestId;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    if (target.endsWith('/cancel')) { cancelCalls++; return response(snapshot(requestId, { state: 'CANCELLED', message: '请求已停止' })); }
    return response(snapshot(target.split('/').at(-1)));
  });
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(api.organizeStatement('# 原题面', undefined, value => updates.push(value)), /AI 整理超时/); }
  finally { clearInterval(keepAlive); }
  assert.equal(cancelCalls, 1); assert.equal(updates.at(-1).state, 'CANCELLED');
});

test('cancel retries a registration race under the same independent deadline without starting another model request', async t => {
  const updates = []; const cancelSignals = []; let requestId; let modelCalls = 0;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (target === '/api/ai/organize') {
      modelCalls++; requestId = JSON.parse(options.body).requestId;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    if (target.endsWith('/cancel')) {
      cancelSignals.push(options.signal);
      if (cancelSignals.length === 1) return new Response(JSON.stringify({ message: '尚未注册' }), { status: 404 });
      return response(snapshot(requestId, { state: 'CANCELLED', stage: 'CANCELLED', message: '请求已取消' }));
    }
    return response(snapshot(target.split('/').at(-1)));
  });
  const controller = new AbortController();
  const operation = api.organizeStatement('# 原题面', controller.signal, value => updates.push(value));
  await waitFor(() => !!requestId); controller.abort();
  await assert.rejects(operation, /已取消 AI 整理/);
  assert.equal(modelCalls, 1); assert.equal(cancelSignals.length, 2);
  assert.equal(cancelSignals[0], cancelSignals[1]); assert.equal(updates.at(-1).state, 'CANCELLED');
  assert.equal(updates.some(value => value.notice), false);
});

test('cancelling during the final status query rejects the result and preserves the cancelled snapshot over a late running read', async t => {
  const finalRead = deferred(); const updates = []; let requestId; let getCalls = 0; let finalStarted = false;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (target === '/api/ai/organize') { requestId = JSON.parse(options.body).requestId; return response({ statement: '# 不应应用的结果' }); }
    if (target.endsWith('/cancel')) return response(snapshot(requestId, { state: 'CANCELLED', stage: 'CANCELLED', message: '请求已取消' }));
    getCalls++;
    if (getCalls === 1) return response(snapshot(target.split('/').at(-1)));
    finalStarted = true; return finalRead.promise;
  });
  const controller = new AbortController();
  const operation = api.organizeStatement('# 原题面', controller.signal, value => updates.push(value));
  await waitFor(() => finalStarted); controller.abort();
  await waitFor(() => updates.some(value => value.state === 'CANCELLED'));
  finalRead.resolve(response(snapshot(requestId)));
  await assert.rejects(operation, /已取消 AI 整理/);
  assert.equal(updates.at(-1).state, 'CANCELLED');
});

test('cancel registration retry stops at its total deadline and reports an unconfirmed cancellation', async t => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal); const updates = []; let requestId; let cancelCalls = 0;
  t.mock.method(AbortSignal, 'timeout', milliseconds => nativeTimeout(milliseconds === 3000 ? 40 : milliseconds));
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (target === '/api/ai/organize') {
      requestId = JSON.parse(options.body).requestId;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    if (target.endsWith('/cancel')) { cancelCalls++; return new Response(JSON.stringify({ message: '尚未注册' }), { status: 404 }); }
    return response(snapshot(target.split('/').at(-1)));
  });
  const controller = new AbortController(); const started = Date.now();
  const operation = api.organizeStatement('# 原题面', controller.signal, value => updates.push(value));
  await waitFor(() => !!requestId); controller.abort();
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(operation, /已取消 AI 整理/); }
  finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - started < 500); assert.equal(cancelCalls, 1);
  assert.match(updates.at(-1).message, /无法确认后台是否停止/);
});

test('a slow in-flight status read is stopped before the final status query, so polls never overlap', async t => {
  const result = deferred(); const updates = []; let requestId; let inFlight = 0; let maxInFlight = 0; let getCalls = 0;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (target === '/api/ai/organize') { requestId = JSON.parse(options.body).requestId; return result.promise; }
    getCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1100);
        options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
      });
      return response(snapshot(requestId, { state: 'SUCCEEDED', message: '整理完成' }));
    } finally { inFlight--; }
  });
  const operation = api.organizeStatement('# 原题面', undefined, value => updates.push(value));
  await delay(100); result.resolve(response({ statement: '# 整理完成' })); await operation;
  assert.equal(getCalls, 2); assert.equal(maxInFlight, 1); assert.equal(updates.at(-1).state, 'SUCCEEDED');
});

test('explicit connection tests attach a request ID while retaining the existing no-input test contract', async t => {
  let requestId; const updates = [];
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (target === '/api/ai/test') { const body = JSON.parse(options.body); requestId = body.requestId; assert.deepEqual(Object.keys(body), ['requestId']); return response({ message: '连接成功', model: 'example' }); }
    return response(snapshot(target.split('/').at(-1), { operation: 'test', state: 'SUCCEEDED' }));
  });
  assert.equal((await api.testAiConnection(undefined, undefined, value => updates.push(value))).message, '连接成功');
  assert.ok(requestId); assert.equal(updates.at(-1).id, requestId);
});
