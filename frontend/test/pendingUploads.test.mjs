import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingUploads } from '../src/pendingUploads.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
test('forced save waits for upload insertion and for another upload started while waiting', async () => {
  const pending = new PendingUploads();
  const first = deferred(), second = deferred();
  const references = [];
  pending.add(first.promise.then(() => { references.push('first.png'); pending.add(second.promise.then(() => { references.push('second.png'); })); }));
  let saved;
  const save = pending.drain().then(() => { saved = [...references]; });
  first.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, undefined);
  second.resolve(); await save;
  assert.deepEqual(saved, ['first.png', 'second.png']);
  assert.equal(pending.pending, false);
});
test('upload failure rejects an in-flight forced flush, preserving the close guard', async () => {
  const pending = new PendingUploads(), upload = deferred();
  pending.add(upload.promise);
  const flush = pending.drain();
  upload.reject(new Error('image write failed'));
  await assert.rejects(flush, /image write failed/);
  assert.equal(pending.pending, false);
});
