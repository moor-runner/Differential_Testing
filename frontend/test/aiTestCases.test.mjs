import test from 'node:test';
import assert from 'node:assert/strict';
import { importGeneratedCases, MAX_CUSTOM_CASES, toDrafts } from '../src/aiTestCases.ts';

test('generated cases become editable drafts with empty expected outputs for unknown answers', () => {
  const drafts = toDrafts([{ category: '边界', input: '1\n5\n', expected: '5', note: 'n 最小' }, { category: '溢出', input: '2\n1 2\n', expected: null, note: '' }]);
  assert.deepEqual(drafts.map(draft => [draft.key, draft.expected]), [['ai-0', '5'], ['ai-1', '']]);
});

test('imported AI cases keep their origin and skip blank or duplicate inputs', () => {
  let next = 0;
  const existing = [{ id: 'old', input: '1\n5', expected: '5' }];
  const drafts = toDrafts([
    { category: '边界', input: '1\n5\n', expected: '5', note: '与已有用例重复' },
    { category: '溢出', input: '2\n2147483647 2147483647\n', expected: '4294967294', note: ' 超过 int ' },
    { category: '一般', input: '  \n', expected: '', note: '' },
    { category: '一般', input: '3\n0 0 0\n', expected: '  ', note: '' },
  ]);
  const { cases, added, skipped } = importGeneratedCases(existing, drafts, () => `new-${next++}`);
  assert.equal(skipped, 2);
  assert.deepEqual(cases[0], existing[0]);
  assert.deepEqual(added, [
    { id: 'new-0', input: '2\n2147483647 2147483647\n', expected: '4294967294', source: 'ai', category: '溢出', note: '超过 int' },
    { id: 'new-1', input: '3\n0 0 0\n', expected: '', source: 'ai', category: '一般' },
  ]);
  assert.equal(cases.length, 3);
});

test('import stops at the custom case limit', () => {
  const existing = Array.from({ length: MAX_CUSTOM_CASES - 1 }, (_, index) => ({ id: `c${index}`, input: `${index}`, expected: '' }));
  const drafts = toDrafts([{ category: '一般', input: 'a', expected: null, note: '' }, { category: '一般', input: 'b', expected: null, note: '' }]);
  const { cases, added, skipped } = importGeneratedCases(existing, drafts, () => crypto.randomUUID());
  assert.equal(cases.length, MAX_CUSTOM_CASES);
  assert.equal(added.length, 1);
  assert.equal(skipped, 1);
});
