import test from 'node:test';
import assert from 'node:assert/strict';
import { JavaAnalysisClient, JavaAnalysisError } from '../src/javaAnalysisClient.ts';

const analysis = name => ({ diagnostics: [], symbols: [{ name }], completions: [], hover: null, definition: null, signatures: [], activeParameter: 0 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('analysis client sends UTF-16 offset and shares same version inspection requests', async () => {
  const calls = [], reply = deferred();
  const client = new JavaAnalysisClient(async (url, init) => { calls.push({ url, init }); return reply.promise; });
  const source = '// 😀\nclass Main {}', offset = source.indexOf('Main');
  const hover = client.request(source, 3, 'inspect', offset);
  const definition = client.request(source, 3, 'inspect', offset);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/editor/java/analyze');
  assert.deepEqual(JSON.parse(calls[0].init.body), { source, operation: 'inspect', offset });
  const value = analysis('Main');
  reply.resolve({ ok: true, json: async () => value });
  assert.equal(await hover, value);
  assert.equal(await definition, value);
  assert.equal(client.peek(3, 'inspect', offset), value);
  client.dispose();
});

test('native-style fetch transport is invoked without the client as its receiver', async () => {
  const client = new JavaAnalysisClient(async function () {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return { ok: true, json: async () => analysis('ReceiverSafe') };
  });
  assert.equal((await client.request('class Main {}', 1, 'analyze')).symbols[0].name, 'ReceiverSafe');
  client.dispose();
});

test('a late stale response cannot populate a new model version', async () => {
  const oldReply = deferred(), calls = [];
  const client = new JavaAnalysisClient(async (_url, init) => { calls.push(init); return calls.length === 1 ? oldReply.promise : { ok: true, json: async () => analysis('Fresh') }; });
  const old = client.request('broken', 1, 'analyze');
  const oldRejected = assert.rejects(old, { name: 'AbortError' });
  const fresh = await client.request('fixed', 2, 'analyze');
  assert.equal(calls[0].signal.aborted, true);
  oldReply.resolve({ ok: true, json: async () => analysis('Stale') });
  await oldRejected;
  assert.equal(client.peek(2, 'analyze'), fresh);
  assert.equal(client.peek(1, 'analyze'), undefined);
  client.dispose();
});

test('cancelling hover does not cancel a shared definition consumer', async () => {
  const reply = deferred(), signals = [];
  const client = new JavaAnalysisClient(async (_url, init) => { signals.push(init.signal); return reply.promise; });
  const cancellation = new AbortController();
  const hover = client.request('class Main {}', 1, 'inspect', 7, cancellation.signal);
  const definition = client.request('class Main {}', 1, 'inspect', 7);
  const rejected = assert.rejects(hover, { name: 'AbortError' });
  cancellation.abort();
  await rejected;
  assert.equal(signals[0].aborted, false);
  reply.resolve({ ok: true, json: async () => analysis('Main') });
  assert.equal((await definition).symbols[0].name, 'Main');
  client.dispose();
});

test('busy server errors are retryable instead of cached forever', async () => {
  let calls = 0;
  const client = new JavaAnalysisClient(async () => ++calls === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => analysis('Ready') });
  await assert.rejects(client.request('class Main {}', 1, 'analyze'), error => error instanceof JavaAnalysisError && error.status === 429);
  assert.equal((await client.request('class Main {}', 1, 'analyze')).symbols[0].name, 'Ready');
  assert.equal(calls, 2);
  client.dispose();
});

test('disposing a model aborts its pending work and rejects future requests', async () => {
  const reply = deferred();
  let signal;
  const client = new JavaAnalysisClient(async (_url, init) => { signal = init.signal; return reply.promise; });
  const request = client.request('source', 1, 'complete', 2);
  const rejected = assert.rejects(request, { name: 'AbortError' });
  client.dispose();
  assert.equal(signal.aborted, true);
  reply.resolve({ ok: true, json: async () => analysis('Disposed') });
  await rejected;
  await assert.rejects(client.request('source', 2, 'complete', 2), { name: 'AbortError' });
});
