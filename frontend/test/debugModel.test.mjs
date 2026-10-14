import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConsoleDelta, childRanges, counterexample, debugResultMessage, debugStatus, emptyConsole, frameLabel, inlineValues, normalizeLines, rangeLabel } from '../src/debugModel.ts';

const delta = (from, chunks, truncated = false) => ({ from, length: from + chunks.reduce((sum, chunk) => sum + chunk.text.length, 0), truncated, chunks });
const out = text => ({ stream: 'out', text }), err = text => ({ stream: 'err', text });

test('breakpoint lines are positive, distinct and sorted', () => {
  assert.deepEqual(normalizeLines([9, 3, 9, 0, -2, 1.5, 4]), [3, 4, 9]);
  assert.deepEqual(normalizeLines([]), []);
});

test('console deltas append, merge same-stream chunks, skip overlap and report gaps', () => {
  let console = applyConsoleDelta(emptyConsole, delta(0, [out('1\n'), out('2\n')]));
  assert.deepEqual(console, { chunks: [out('1\n2\n')], length: 4, truncated: false });
  console = applyConsoleDelta(console, delta(4, [err('boom\n'), out('3')]));
  assert.deepEqual(console.chunks, [out('1\n2\n'), err('boom\n'), out('3')]);
  assert.equal(console.length, 10);
  // A delta that repeats text already shown (a late reply after a refetch) only adds what is new.
  const overlapping = applyConsoleDelta(console, delta(7, [err('m\n'), out('34')]));
  assert.deepEqual(overlapping.chunks, [out('1\n2\n'), err('boom\n'), out('34')]);
  assert.equal(overlapping.length, 11);
  assert.equal(applyConsoleDelta(console, delta(12, [out('x')])), null, 'a gap must be fetched first');
  // A new subscription starts from 0 with everything and replaces what was shown.
  assert.deepEqual(applyConsoleDelta(console, delta(0, [out('fresh')], true)), { chunks: [out('fresh')], length: 5, truncated: true });
});

test('big containers nest ranges of 100 so any index is a few clicks away', () => {
  assert.equal(childRanges(0, 100), null);
  assert.deepEqual(childRanges(0, 250), [{ start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 250 }]);
  const million = childRanges(0, 1_000_000);
  assert.equal(million.length, 100);
  assert.deepEqual(million[99], { start: 990_000, end: 1_000_000 });
  assert.equal(rangeLabel(million[1]), '[10000..19999]');
  assert.equal(childRanges(10_000, 20_000).length, 100);
  assert.equal(childRanges(19_900, 20_000), null);
  assert.equal(childRanges(0, 10_001).length, 2, 'just over 100 × 100 needs a bigger bucket');
});

test('inline values list variables per line of the paused method, skipping strings, comments and members', () => {
  const source = [
    'public class Main {',
    '    static int solve(int n, int[] a) {',
    '        long sum = 0; // n is the size',
    '        for (int i = 0; i < n; i++) {',
    '            sum += a[i] * 2;',
    '            System.out.println("sum " + a.length);',
    '        }',
    '        return (int) sum;',
    '    }',
    '}',
  ].join('\n');
  const scope = new Map(Object.entries({
    n: { name: 'n', value: '3', kind: 'primitive' }, a: { name: 'a', value: '[1, 2, 3]', kind: 'array' },
    sum: { name: 'sum', value: '6', kind: 'primitive' }, i: { name: 'i', value: '1', kind: 'primitive' },
    length: { name: 'length', value: 'not a member', kind: 'primitive' },
  }));
  const values = inlineValues(source, { line: 6, methodStart: 3, method: 'solve', className: 'Main' }, scope);
  assert.deepEqual(values, [
    { line: 2, text: 'n = 3, a = [1, 2, 3]' },
    { line: 3, text: 'sum = 6' },
    { line: 4, text: 'i = 1, n = 3' },
    { line: 5, text: 'sum = 6, a = [1, 2, 3], i = 1' },
    { line: 6, text: 'a = [1, 2, 3]' },
  ]);
  assert.deepEqual(inlineValues(source, { line: -1, methodStart: 3, method: 'solve', className: 'Main' }, scope), []);
  const objects = new Map([['in', { name: 'in', value: '{buf=HeapCharBuffer@371, position=1}', type: 'Scanner@364', kind: 'object' }]]);
  assert.deepEqual(inlineValues('Scanner in = null;\nint n = in.nextInt();', { line: 2, methodStart: 1, method: 'main', className: 'Main' }, objects), [{ line: 1, text: 'in = Scanner@364' }, { line: 2, text: 'in = Scanner@364' }]);
  const long = new Map([['sum', { name: 'sum', value: 'x'.repeat(100), kind: 'string' }]]);
  assert.ok(inlineValues(source, { line: 3, methodStart: 3, method: 'solve', className: 'Main' }, long)[0].text.endsWith('…'));
});

test('frame labels read like IDEA and statuses describe where the program is', () => {
  assert.equal(frameLabel({ method: 'fib', className: 'Main', line: 26 }), 'fib:26');
  assert.equal(frameLabel({ method: '<init>', className: 'Node', line: 4 }), 'Node():4');
  assert.equal(frameLabel({ method: '<clinit>', className: 'Main', line: 2 }), 'static {}:2');
  assert.equal(frameLabel({ method: 'lambda$main$0', className: 'Main', line: 8 }), 'lambda（main）:8');
  assert.equal(frameLabel({ method: 'parseInt', className: 'Integer', line: -1 }), 'parseInt');
  const frames = [{ index: 0, method: 'parseInt', className: 'Integer', line: 662, user: false }, { index: 1, method: 'main', className: 'Main', line: 4, user: true }];
  const paused = { state: 'PAUSED', message: '', pause: { reason: 'exception', frames, frameIndex: 1 } };
  assert.equal(debugStatus(paused), '异常 · 第 4 行');
  assert.equal(debugStatus({ ...paused, pause: { ...paused.pause, reason: 'step' } }), '已暂停 · 第 4 行');
  assert.equal(debugStatus({ state: 'RUNNING', message: '' }), '运行中');
  const wrong = { state: 'TERMINATED', message: '', result: { verdict: 'WA', exitCode: 0, firstDifference: { line: 2, expected: '5', actual: '' } } };
  assert.equal(debugStatus(wrong), '答案错误');
  assert.equal(debugResultMessage(wrong), '第 2 行不同：期望 5，实际 （空行）');
  assert.equal(debugResultMessage({ ...wrong, result: { verdict: 'RE', exitCode: 1, firstDifference: null } }), '程序异常退出（退出码 1），见控制台中的 stderr');
});

test('a failing duipai round becomes a case for the solver at fault', () => {
  const ok = { stdout: '6\n', stderr: '', elapsedMs: 5, exitCode: 0, timedOut: false, outputLimited: false };
  const job = { state: 'FINISHED', verdict: 'WA', seed: '42', input: '3\n1 2 3\n', brute: ok, optimized: { ...ok, stdout: '7\n' } };
  assert.deepEqual(counterexample(job), { role: 'optimized', entry: { label: '反例 · 种子 42', input: '3\n1 2 3\n', expected: '6\n' } });
  assert.equal(counterexample({ ...job, verdict: 'TLE', brute: { ...ok, timedOut: true } }).entry.expected, '', 'no trusted answer without a clean brute run');
  assert.deepEqual(counterexample({ ...job, verdict: 'BRUTE_ERROR', brute: { ...ok, exitCode: 1 } }).role, 'brute');
  assert.equal(counterexample({ ...job, verdict: 'GENERATOR_ERROR' }), null);
  assert.equal(counterexample({ ...job, verdict: 'PASS' }), null);
  assert.equal(counterexample({ ...job, state: 'RUNNING' }), null);
  assert.equal(counterexample({ ...job, input: null }), null);
});
