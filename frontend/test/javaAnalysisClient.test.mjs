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

test('typing more of the same identifier keeps and shares the in-flight completion', async () => {
  const reply = deferred(), calls = [];
  const client = new JavaAnalysisClient(async (_url, init) => { calls.push(init); return reply.promise; });
  const before = 'class Main { void run() { int length = 1; l', after = '; } }';
  const first = client.complete(`${before}${after}`, before.length - 1, before.length, before.length, new AbortController().signal);
  // Monaco's own edit invalidates analysis versions; it must not cancel the completion it is still waiting for.
  client.invalidate(2);
  const typedOn = `${before}en${after}`;
  const second = client.complete(typedOn, before.length - 1, before.length + 2, before.length + 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  assert.equal(JSON.parse(calls[0].body).offset, before.length);
  const value = analysis('length');
  reply.resolve({ ok: true, json: async () => value });
  assert.equal(await first, value);
  assert.equal(await second, value);
  client.dispose();
});

test('a completion is requested again when the surrounding code or a shorter prefix no longer fits the shared result', async () => {
  const calls = [];
  const client = new JavaAnalysisClient(async (_url, init) => { calls.push(init); return { ok: true, json: async () => analysis(`call${calls.length}`) }; });
  const source = 'class Main { void run() { ab; } }', start = source.indexOf('ab');
  await client.complete(source, start, start + 2, start + 2);
  await client.complete(source, start, start + 2, start + 2);
  assert.equal(calls.length, 1, 'same context and prefix reuse the cached result');
  await client.complete(source, start, start + 2, start + 1);
  assert.equal(calls.length, 2, 'deleting back to a shorter prefix needs a wider result');
  const edited = source.replace('run', 'go');
  await client.complete(edited, start - 1, start + 1, start + 1);
  assert.equal(calls.length, 3, 'an edit outside the identifier changes the compiler context');
  client.dispose();
});

test('cancelling one completion consumer leaves the shared request for the next keystroke', async () => {
  const reply = deferred(), signals = [];
  const client = new JavaAnalysisClient(async (_url, init) => { signals.push(init.signal); return reply.promise; });
  const source = 'class Main { void run() { x; } }', start = source.indexOf('x;');
  const cancellation = new AbortController();
  const cancelled = client.complete(source, start, start + 1, start + 1, cancellation.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  cancellation.abort();
  await rejected;
  const next = client.complete(source, start, start + 1, start + 1);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  reply.resolve({ ok: true, json: async () => analysis('Shared') });
  assert.equal((await next).symbols[0].name, 'Shared');
  client.dispose();
});

test('a new completion context aborts the previous one, and disposal aborts the current one', async () => {
  const signals = [];
  // Like fetch, the transport rejects once its signal aborts.
  const client = new JavaAnalysisClient(async (_url, init) => { signals.push(init.signal); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))); });
  const old = client.complete('class A { a }', 10, 11, 11);
  const oldRejected = assert.rejects(old, { name: 'AbortError' });
  const current = client.complete('class B { b }', 10, 11, 11);
  const currentRejected = assert.rejects(current, { name: 'AbortError' });
  assert.equal(signals[0].aborted, true);
  client.dispose();
  assert.equal(signals[1].aborted, true);
  await assert.rejects(client.complete('class B { b }', 10, 11, 11), { name: 'AbortError' });
  await Promise.all([oldRejected, currentRejected]);
});

test('a completion list cut at the server cap is reused only for the same prefix', async () => {
  const calls = [];
  const client = new JavaAnalysisClient(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ...analysis('page'), incomplete: calls.length === 1 }) };
  });
  const source = 'class Main { void run() { Sc; } }', start = source.indexOf('Sc');
  await client.complete(source, start, start + 2, start);
  await client.complete(source, start, start + 2, start);
  assert.equal(calls.length, 1, 'the same prefix gets the same truncated page');
  await client.complete(source, start, start + 2, start + 1);
  assert.equal(calls.length, 2, 'a longer prefix asks for the matches past the cap');
  await client.complete(source, start, start + 2, start + 2);
  assert.equal(calls.length, 2, 'a complete list covers every longer prefix again');
  client.dispose();
});

test('typing inside an argument shares one signature request; another argument asks again', async () => {
  const calls = [], reply = deferred();
  const client = new JavaAnalysisClient(async (_url, init) => { calls.push(init); return reply.promise; });
  const first = client.signature('f(a', 1, 0, 3);
  client.edited(3); // typing after the `(` leaves the call and its answer unchanged
  const cancellation = new AbortController();
  const typed = client.signature('f(ab', 1, 0, 4, cancellation.signal);
  const rejected = assert.rejects(typed, { name: 'AbortError' });
  cancellation.abort(); // Monaco cancels the previous hint request at every keystroke
  await rejected;
  const later = client.signature('f(abc', 1, 0, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(JSON.parse(calls[0].body), { source: 'f(a', operation: 'signature', offset: 3 });
  const value = analysis('f');
  reply.resolve({ ok: true, json: async () => value });
  assert.equal(await first, value);
  assert.equal(await later, value);
  const next = assert.rejects(client.signature('f(abc, ', 1, 1, 7), { name: 'AbortError' });
  assert.equal(calls.length, 2, 'the next argument has its own active parameter and overload order');
  client.dispose();
  await next;
});

test('an edit reaching the call\'s parenthesis aborts its signature request, and disposal aborts the rest', async () => {
  const calls = [];
  // Like fetch, a pending response fails once its signal aborts.
  const client = new JavaAnalysisClient(async (_url, init) => { calls.push(init); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))); });
  const outer = client.signature('g(1, f(', 1, 1, 7);
  const inner = client.signature('g(1, f(', 6, 0, 7);
  const outerRejected = assert.rejects(outer, { name: 'AbortError' }), innerRejected = assert.rejects(inner, { name: 'AbortError' });
  client.edited(6);
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls[0].signal.aborted, false, 'the outer call opens before the edit');
  const replaced = assert.rejects(client.signature('g(1, h(', 6, 0, 7), { name: 'AbortError' });
  assert.equal(calls.length, 3);
  client.dispose();
  assert.ok(calls.every(call => call.signal.aborted));
  await Promise.all([outerRejected, innerRejected, replaced]);
  await assert.rejects(client.signature('g(', 1, 0, 2), { name: 'AbortError' });
});
