import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSnapshot } from '../src/jobSnapshots.ts';

const snapshot = (overrides = {}) => ({ id: 'job-1', state: 'RUNNING', verdict: null, completed: 1, elapsedMs: 4000, ...overrides });

test('late RUNNING cancellation HTTP response cannot overwrite SSE CANCELLED terminal state', async () => {
  let resolveCancel;
  const cancelResponse = new Promise(resolve => { resolveCancel = resolve; });
  let current = snapshot();
  const cancellation = cancelResponse.then(next => { current = advanceSnapshot(current, next, 'job-1'); });
  current = advanceSnapshot(current, snapshot({ state: 'FINISHED', verdict: 'CANCELLED', elapsedMs: 4013 }), 'job-1');
  const terminal = current;
  resolveCancel(snapshot({ message: '正在停止任务并清理子进程' }));
  await cancellation;
  assert.equal(current, terminal);
  assert.equal(current.verdict, 'CANCELLED');
});
test('state and progress cannot regress when polling arrives after newer SSE', () => {
  const running = snapshot({ completed: 6, elapsedMs: 9000 });
  assert.equal(advanceSnapshot(running, snapshot({ state: 'COMPILING', elapsedMs: 8000 }), 'job-1'), running);
  assert.equal(advanceSnapshot(running, snapshot({ completed: 5, elapsedMs: 9500 }), 'job-1'), running);
  assert.equal(advanceSnapshot(running, snapshot({ completed: 6, elapsedMs: 8500 }), 'job-1'), running);
});
test('a terminal snapshot is accepted regardless of lagging interim progress metrics', () => {
  const terminal = snapshot({ state: 'FINISHED', verdict: 'PASS', completed: 5, elapsedMs: 7500 });
  assert.equal(advanceSnapshot(snapshot({ completed: 6, elapsedMs: 8000 }), terminal, 'job-1'), terminal);
});
test('late previous-job requests cannot overwrite a new job or a cleared problem view', () => {
  const nextJob = snapshot({ id: 'job-2', state: 'COMPILING', elapsedMs: 0, completed: 0 });
  assert.equal(advanceSnapshot(nextJob, snapshot({ state: 'FINISHED' }), 'job-1'), nextJob);
  assert.equal(advanceSnapshot(null, snapshot(), 'job-1'), null);
});
test('explicit start and historical selections may display a different job', () => {
  const prior = snapshot({ state: 'FINISHED', verdict: 'PASS' });
  const next = snapshot({ id: 'job-2', state: 'COMPILING', elapsedMs: 0, completed: 0 });
  assert.equal(advanceSnapshot(prior, next), next);
  assert.equal(advanceSnapshot(null, next), next);
});
