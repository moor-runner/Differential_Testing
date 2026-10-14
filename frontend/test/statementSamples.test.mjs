import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statementSamples } from '../src/statementSamples.ts';

const fence = (text, info = 'text') => `\`\`\`${info}\n${text}\n\`\`\``;

test('the new-problem template sample pairs a fenced input with its inline output', () => {
  const statement = `# 区间和\n\n给定 $n$ 个整数，输出它们的和。\n\n## 输入格式\n第一行是整数 $n$，第二行是 $n$ 个整数。\n\n## 样例\n${fence('3\n1 2 3')}\n输出 \`6\`。\n\n生成器通过 \`args[0]\` 接收种子。三个编辑器中的程序都应为 \`public class Main\`。\n`;
  assert.deepEqual(statementSamples(statement), [{ input: '3\n1 2 3', expected: '6' }]);
});

test('hand-written 样例 sections with 输入：/输出： labels ignore code blocks in explanations', () => {
  const statement = readFileSync(new URL('../../docs/数字消除游戏.md', import.meta.url), 'utf8');
  assert.deepEqual(statementSamples(statement), [{ input: '1', expected: '1' }, { input: '9', expected: '6' }]);
});

test('AI 整理 and 图片识别 headings are both recognized', () => {
  const ai = `## 输入格式\n一行。\n\n## 样例\n\n### 样例 1 输入\n\n${fence('2 3')}\n\n### 样例 1 输出\n\n${fence('5')}\n\n### 样例 1 说明\n\n${fence('2 + 3 = 5')}\n\n### 样例 2 输入\n\n${fence('-1 1')}\n\n### 样例 2 输出\n\n${fence('0')}\n\n## 提示与说明\n\n${fence('ignored')}`;
  assert.deepEqual(statementSamples(ai), [{ input: '2 3', expected: '5' }, { input: '-1 1', expected: '0' }]);
  const ocr = `## 测试样例\n\n### 输入样例 1\n\n${fence('4\n1 2 3 4')}\n\n### 输出样例 1\n\n${fence('10')}\n\n### 样例 1 说明\n\n累加。`;
  assert.deepEqual(statementSamples(ocr), [{ input: '4\n1 2 3 4', expected: '10' }]);
});

test('English Input/Output headings and numbered outputs listed after all inputs', () => {
  const english = `## Input\n${fence('n m')}\n\n## Examples\n\n### Input\n${fence('1 2', '')}\n### Output\n${fence('3', '')}\n### Note\n${fence('1 + 2', '')}\n\n## Constraints\n${fence('1 <= n')}`;
  assert.deepEqual(statementSamples(english), [{ input: '1 2', expected: '3' }]);
  const numbered = `### 样例输入 1\n${fence('a')}\n### 样例输入 2\n${fence('b')}\n### 样例输出 1\n${fence('A')}\n### 样例输出 2\n${fence('B')}`;
  assert.deepEqual(statementSamples(numbered), [{ input: 'a', expected: 'A' }, { input: 'b', expected: 'B' }]);
});

test('code outside sample sections, source code and samples without output', () => {
  assert.deepEqual(statementSamples(`## 输入格式\n${fence('n')}\n\n## 解法\n${fence('class Main {}', 'java')}`), []);
  assert.deepEqual(statementSamples(`**样例 1**\n\n输入：\n\n${fence('7')}\n\n**样例 2**\n\n输入：\n${fence('8')}\n输出：\n${fence('16')}`),
    [{ input: '7', expected: '' }, { input: '8', expected: '16' }]);
  assert.deepEqual(statementSamples(`## 样例\r\n~~~~\r\n  x\r\n~~~~\r\n~~~\r\ny\r\n~~~`), [{ input: '  x', expected: 'y' }]);
  assert.deepEqual(statementSamples(`- 样例输入：\n  \`\`\`\n  1 2\n  \`\`\`\n- 样例输出：\`3\``), [{ input: '1 2', expected: '3' }]);
});
