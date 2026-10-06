import test from 'node:test';
import assert from 'node:assert/strict';
import { bounded, MAX_PREVIEW, normalize } from '../src/output.ts';

test('diff retains nonbreaking spaces that the judge considers meaningful', () => {
  for (const whitespace of ['\u00a0', '\u2007', '\u202f', '\ufeff']) {
    assert.notEqual(normalize(`answer${whitespace}\n`), normalize('answer\n'));
  }
});
test('diff matches Java trailing whitespace and CRLF handling without dropping leading spaces', () => {
  assert.equal(normalize('answer \t\r\n\r\n'), 'answer');
  assert.equal(normalize('answer\u001c\u001d\u001e\u001f\u1680\u2000\u2006\u2008\u200a\u2028\u2029\u205f\u3000\n'), 'answer');
  assert.notEqual(normalize(' answer\n'), normalize('answer\n'));
  assert.notEqual(normalize('answer\n\nnext'), normalize('answer\nnext'));
});
test('large UTF-8 preview is bounded while retaining complete short output', () => {
  assert.deepEqual(bounded('测试输出\n'), { text: '测试输出\n', truncated: false });
  const result = bounded('A'.repeat(MAX_PREVIEW + 1));
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.text), MAX_PREVIEW);
});
