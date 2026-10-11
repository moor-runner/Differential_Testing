import test from 'node:test';
import assert from 'node:assert/strict';
import { retitleStatement } from '../src/statementTitle.ts';

test('rename updates the leading heading that still shows the previous title', () => {
  assert.equal(retitleStatement('# 滴滴1\n\n给定 $n$ 个整数。\n', '滴滴1', '区间和'), '# 区间和\n\n给定 $n$ 个整数。\n');
  assert.equal(retitleStatement('\n#  滴滴1  \r\n正文', '滴滴1', '区间和'), '\n#  区间和\r\n正文');
  assert.equal(retitleStatement('# 滴滴1', '滴滴1', '区间和'), '# 区间和');
});

test('rename keeps headings the user changed and statements without a leading title', () => {
  for (const statement of ['# 数字消除游戏\n\n正文', '正文\n\n# 滴滴1', '## 滴滴1\n正文', '#滴滴1\n正文', ''])
    assert.equal(retitleStatement(statement, '滴滴1', '区间和'), statement);
});
