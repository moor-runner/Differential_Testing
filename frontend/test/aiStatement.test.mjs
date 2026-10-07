import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAiStatement, parseAiStatement, applyAiStatement } from '../src/aiStatement.ts';

test('AI input excludes source images and independent notes, while retaining nested problem headings', () => {
  const original = '# 原题\n\n## 题目描述\n描述。\n### 操作步骤\n步骤。\n![原图](/api/images/one.png)\n\n## 个人笔记\n不能发送这段笔记。\n### 思路\n不能发送这里。\n\n## 输入格式\n一个整数。\n![图片][image]\n[image]: /api/images/two.png\n\n## 自定义附件\n我的外部备注。\n';
  const prepared = prepareAiStatement(original);
  assert.match(prepared, /步骤。|一个整数。/);
  assert.doesNotMatch(prepared, /api\/images|原图|不能发送|外部备注|个人笔记/);
});
test('fenced input retains exact whitespace and heading-like data during AI parsing', () => {
  const sample = '```text\n## 输入格式\n![sample](/api/images/literal.png)\n1  2\n\n\n3\n```';
  const markdown = `# 数字消除游戏\n\n## 题目描述\n段落一。\n\n段落二。\n\n## 输入格式\n整数 n。\n\n## 输出格式\n答案。\n\n## 测试样例\n### 样例 1\n#### 输入\n${sample}\n\n#### 输出\n\`\`\`text\n6\n\`\`\`\n\n#### 解释\n解释中的分段。\n\n## 数据范围\n1 <= n <= 1000000\n`;
  const sections = parseAiStatement(markdown);
  const mapped = Object.fromEntries(sections.map(section => [section.kind, section.content]));
  assert.equal(mapped.title, '数字消除游戏');
  assert.equal(mapped.input, '整数 n。');
  assert.equal(mapped.description, '段落一。\n\n段落二。');
  assert.ok(mapped.samples.includes(sample));
  assert.match(mapped.samples, /#### 解释\n解释中的分段。/);
  assert.equal(mapped.notes, undefined);
  assert.equal(mapped.constraints, '1 <= n <= 1000000');
});
test('numbered standalone samples remain grouped and an optional Markdown envelope is removed', () => {
  const result = parseAiStatement('````markdown\n# 数字消除游戏\n\n## 样例 1\n输入：1\n输出：1\n\n## 样例 2\n输入：9\n输出：6\n````');
  const sample = result.find(section => section.kind === 'samples').content;
  assert.match(sample, /^### 样例 1/); assert.match(sample, /### 样例 2/);
  assert.doesNotMatch(sample, /````markdown/);
});
test('AI application preserves original images, unknown sections and omitted output', () => {
  const original = '# 原题\n\n旧描述\n![原图](/api/images/one.png)\n\n## 输出格式\n保留旧输出。\n\n## 我的思路\n保留原文。\n';
  const sections = parseAiStatement('# 新题\n\n## 题目描述\n新描述\n![伪造图片](/api/images/fake.png)\n\n## 输入格式\n新输入。\n');
  const applied = applyAiStatement(original, sections);
  assert.match(applied, /^# 新题/); assert.doesNotMatch(applied, /旧描述|fake.png/);
  assert.match(applied, /## 输出格式\n保留旧输出。/); assert.match(applied, /## 我的思路\n保留原文。/);
  assert.equal(applied.match(/\/api\/images\/one.png/g).length, 1);
  assert.equal(applyAiStatement(original, []), original);
});
test('unstructured or empty AI output is rejected without inventing a section', () => {
  assert.deepEqual(parseAiStatement(''), []);
  assert.deepEqual(parseAiStatement('这只是一个回复，没有题面内容。'), []);
});
