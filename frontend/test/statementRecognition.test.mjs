import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecognizedStatement, mergeRecognizedStatement } from '../src/statementRecognition.ts';

const line = (text, y, overrides = {}) => ({ text, x: 20, y, width: 450, height: 24, ...overrides });
const image = lines => ({ url: '/api/images/statement.png', width: 1000, height: 1400, language: 'zh-Hans', lines });
const section = (kind, content, overrides = {}) => ({ id: kind, kind, title: ({ title: '题目标题', description: '题目描述', input: '输入格式', output: '输出格式', samples: '测试样例', constraints: '数据范围', notes: '提示' })[kind], content, regions: [], ...overrides });
const contents = images => Object.fromEntries(parseRecognizedStatement(images).map(section => [section.kind, section.content]));

test('Chinese OCR headings map to their sections and spaced Han prose is readable without changing numeric samples', () => {
  const result = parseRecognizedStatement([image([
    line('题目标题：数组求和', 0), line('题 目 描 述', 40), line('给 定 n 个 整 数， 求 和。', 80),
    line('输 入 格 式', 120), line('第 一 行 是 n。', 160), line('输出格式：输出总和。', 200),
    line('输 入 样 例 1', 240), line('3', 280), line('1  2  3', 320),
    line('输 出 样 例 1', 360), line('6', 400), line('数 据 范 围', 440), line('1 < = n < = 1000', 480),
    line('提示', 520), line('使 用 long。', 560),
  ])]);
  const mapped = Object.fromEntries(result.map(section => [section.kind, section.content]));
  assert.deepEqual(Object.keys(mapped), ['title', 'description', 'input', 'output', 'samples', 'constraints', 'notes']);
  assert.equal(mapped.title, '数组求和');
  assert.equal(mapped.description, '给定 n 个整数，求和。');
  assert.equal(mapped.input, '第一行是 n。');
  assert.equal(mapped.output, '输出总和。');
  assert.equal(mapped.constraints, '1 <= n <= 1000');
  assert.match(mapped.samples, /### 输入样例 1\n\n```text\n3\n1  2  3\n```/);
  assert.match(mapped.samples, /### 输出样例 1\n\n```text\n6\n```/);
  assert.deepEqual(result.find(section => section.kind === 'constraints').regions, [{ imageIndex: 0, x: 20, y: 440, width: 450, height: 64 }]);
});

test('English headers and numbered examples are mapped without treating sample Input as the input format', () => {
  const mapped = contents([image([
    line('A. Sum', 0), line('Problem Description', 40), line('Add the values.', 80),
    line('Input Specification', 120), line('Read n integers.', 160), line('Output', 200), line('Print their sum.', 240),
    line('Sample Input #2', 280), line('2\n10 20', 320), line('Sample Output #2', 360), line('30', 400),
    line('Constraints', 440), line('n <= 100', 480), line('Note', 520), line('Use integers.', 560),
  ])]);
  assert.equal(mapped.title, 'A. Sum'); assert.equal(mapped.input, 'Read n integers.'); assert.equal(mapped.output, 'Print their sum.');
  assert.match(mapped.samples, /输入样例 2/); assert.match(mapped.samples, /输出样例 2/);
  assert.equal(mapped.notes, 'Use integers.');
});

test('an unheaded screenshot falls back to description; empty or invalid OCR cannot erase text', () => {
  const mapped = contents([image([line('Read three integers.', 10), line('Find the sum.', 50), line('输入格式', 90)])]);
  assert.deepEqual(mapped, { description: 'Read three integers.\n\nFind the sum.' });
  assert.deepEqual(parseRecognizedStatement([image([line('', 0), line('broken', 10, { width: NaN })])]), []);
});

test('title inference requires a larger first line and semantic headings', () => {
  const recognized = contents([image([line('数 组 求 和', 10, { height: 48 }), line('题 目 描 述', 80, { height: 36 }), line('计算总和。', 130)])]);
  assert.equal(recognized.title, '数组求和'); assert.equal(recognized.description, '计算总和。');
  const ordinary = contents([image([line('这是一段描述', 10), line('题目描述', 80), line('另一段描述', 130)])]);
  assert.equal(ordinary.title, undefined); assert.match(ordinary.description, /这是一段描述/);
});

test('multiple screenshots continue a section and repeated ranges retain both content and coordinates', () => {
  const result = parseRecognizedStatement([
    image([line('题目描述', 0), line('描述的第一页', 40), line('数据范围', 80), line('1 <= n <= 10', 120)]),
    image([line('0 <= a <= 100', 0), line('数据范围与约定', 40), line('保证有解', 80), line('提示', 120), line('另一张图的提示', 160)]),
  ]);
  const constraints = result.find(section => section.kind === 'constraints');
  assert.equal(constraints.content, '1 <= n <= 10\n0 <= a <= 100\n\n保证有解');
  assert.deepEqual(constraints.regions.map(region => region.imageIndex), [0, 1, 1]);
  assert.equal(result.find(section => section.kind === 'notes').content, '另一张图的提示');
});

test('generic numbered examples scope vertical Input and Output labels to samples', () => {
  const mapped = contents([image([
    line('Examples 1', 0), line('Input', 40), line('1 2', 80), line('Output', 120), line('3', 160),
    line('Example 2', 200), line('Input', 240), line('2 3', 280), line('Output', 320), line('5', 360),
    line('Input Format', 400), line('Read two integers.', 440),
  ])]);
  assert.match(mapped.samples, /输入样例 1\n\n```text\n1 2\n```/);
  assert.match(mapped.samples, /输出样例 1\n\n```text\n3\n```/);
  assert.match(mapped.samples, /输入样例 2\n\n```text\n2 3\n```/);
  assert.equal(mapped.input, 'Read two integers.');
});

test('Chinese OCR spacing cleanup preserves paragraph and section breaks', () => {
  const mapped = contents([image([line('题目描述', 0), line('第 一 行', 40), line('第 二 行', 80), line('题目描述', 120), line('第 三 行', 160)])]);
  assert.equal(mapped.description, '第一行\n\n第二行\n\n第三行');
});

test('side-by-side sample columns stay separate even with unequal line counts', () => {
  const mapped = contents([image([
    line('Input', 0, { x: 20, width: 200 }), line('Output', 0, { x: 550, width: 200 }),
    line('3', 40, { width: 200 }), line('6', 40, { x: 550, width: 200 }), line('1 2 3', 80, { width: 200 }),
    line('Constraints', 130), line('n <= 100', 170),
  ])]);
  assert.equal(mapped.input, undefined); assert.equal(mapped.output, undefined);
  assert.match(mapped.samples, /输入样例 1\n\n```text\n3\n1 2 3\n```/);
  assert.match(mapped.samples, /输出样例 1\n\n```text\n6\n```/);
  assert.equal(mapped.constraints, 'n <= 100');
});

test('explicit input/output format columns retain their semantics and separate bodies', () => {
  const mapped = contents([image([
    line('输入格式', 0, { x: 20, width: 200 }), line('输出格式', 0, { x: 600, width: 200 }),
    line('读入 n 个整数。', 40, { x: 20, width: 200 }), line('输出总和。', 40, { x: 600, width: 200 }),
  ])]);
  assert.deepEqual(mapped, { input: '读入 n 个整数。', output: '输出总和。' });
});

test('a third caption sharing the sample header row is retained as notes with its original region', () => {
  const result = parseRecognizedStatement([image([
    line('输入样例', 0, { x: 20, width: 180 }), line('输出样例', 0, { x: 350, width: 180 }),
    line('解释文字', 0, { x: 750, width: 180 }), line('1 2', 40, { x: 20, width: 180 }), line('3', 40, { x: 350, width: 180 }),
  ])]);
  const notes = result.find(section => section.kind === 'notes');
  assert.equal(notes.content, '解释文字');
  assert.deepEqual(notes.regions, [{ imageIndex: 0, x: 750, y: 0, width: 180, height: 24 }]);
  const samples = result.find(section => section.kind === 'samples').content;
  assert.match(samples, /输入样例 1\n\n```text\n1 2\n```/); assert.match(samples, /输出样例 1\n\n```text\n3\n```/);
  assert.doesNotMatch(samples, /解释文字/);
});

test('word rectangles split samples combined into single OCR rows', () => {
  const word = (text, x, y, width = 80) => ({ text, x, y, width, height: 24 });
  const mapped = contents([image([
    line('输入样例 输出样例', 0, { width: 780, words: [word('输入样例', 20, 0, 160), word('输出样例', 600, 0, 160)] }),
    line('2  3', 40, { width: 780, words: [word('2', 20, 40), word('3', 600, 40)] }),
    line('1 2', 80, { width: 200, words: [word('1', 20, 80), word('2', 100, 80)] }),
  ])]);
  assert.match(mapped.samples, /输入样例 1\n\n```text\n2\n1 2\n```/);
  assert.match(mapped.samples, /输出样例 1\n\n```text\n3\n```/);
});

test('reversed sample columns still pair input and output and numbered samples stay distinct', () => {
  const mapped = contents([image([
    line('Sample Output', 0, { x: 20, width: 200 }), line('Sample Input', 0, { x: 600, width: 200 }),
    line('3', 40, { x: 20, width: 200 }), line('1 2', 40, { x: 600, width: 200 }),
    line('Sample Input', 100, { x: 20, width: 200 }), line('Sample Output', 100, { x: 600, width: 200 }),
    line('2 3', 140, { x: 20, width: 200 }), line('5', 140, { x: 600, width: 200 }),
  ])]);
  assert.match(mapped.samples, /输入样例 1\n\n```text\n1 2\n```/); assert.match(mapped.samples, /输出样例 1\n\n```text\n3\n```/);
  assert.match(mapped.samples, /输入样例 2/); assert.match(mapped.samples, /输出样例 2/);
});

test('merge replaces only selected sections and preserves implicit description, unrelated headings and original images', () => {
  const existing = '# 原题\n\n原描述\n![截图](/api/images/one.png)\n\n## 输入格式\n旧输入\n\n## 输出格式\n旧输出\n\n## 我的思路\n保留我写的笔记。\n\n## 数据范围\n旧范围\n';
  const merged = mergeRecognizedStatement(existing, [section('input', '新输入'), section('constraints', '1 <= n <= 100')]);
  assert.match(merged, /^# 原题\n\n原描述\n!\[截图\]\(\/api\/images\/one.png\)/);
  assert.match(merged, /## 输入格式\n\n新输入/); assert.doesNotMatch(merged, /旧输入|旧范围/);
  assert.match(merged, /## 输出格式\n旧输出/); assert.match(merged, /## 我的思路\n保留我写的笔记。/);
});

test('merge edits the Markdown title and implicit description while preserving original screenshots', () => {
  const existing = '# 原题\n\n原描述\n![原图](/api/images/one.png)\n\n## 输入格式\n旧输入\n\n![第二张](/api/images/two.png)\n';
  const merged = mergeRecognizedStatement(existing, [section('title', '新题'), section('description', '新的描述'), section('input', '新的输入')]);
  assert.match(merged, /^# 新题\n\n新的描述/); assert.doesNotMatch(merged, /原描述|旧输入/);
  for (const url of ['one', 'two']) assert.equal(merged.match(new RegExp(`/api/images/${url}\\.png`, 'g')).length, 1);
});

test('an explicit description takes precedence over arbitrary preamble and title notes', () => {
  const existing = '个人备忘\n\n# 原题\n\n来源和作者信息\n\n## 题目描述\n旧描述\n\n## 输入格式\n输入\n';
  const merged = mergeRecognizedStatement(existing, [section('description', '新描述')]);
  assert.match(merged, /^个人备忘\n\n# 原题\n\n来源和作者信息/);
  assert.match(merged, /## 题目描述\n\n新描述/); assert.doesNotMatch(merged, /旧描述/);
});

test('duplicate mapped kinds merge content and duplicate existing headings do not keep stale text', () => {
  const existing = '## 输入格式\n旧输入一\n\n## 输入\n旧输入二\n\n## 其他\n继续保留\n';
  const merged = mergeRecognizedStatement(existing, [section('input', '第一页输入'), section('input', '第二页输入', { id: 'input-2' })]);
  assert.match(merged, /第一页输入\n\n第二页输入/); assert.doesNotMatch(merged, /旧输入一|旧输入二/);
  assert.equal(merged.match(/第一页输入/g).length, 1); assert.match(merged, /## 其他\n继续保留/);
});

test('Markdown-looking sample data in code fences is never interpreted as a section boundary', () => {
  const existing = '# 原题\n\n## 测试样例\n```text\n## 输入格式\n![这是样例字符](/api/images/fake.png)\n```\n\n## 输出格式\n旧输出\n';
  const merged = mergeRecognizedStatement(existing, [section('output', '新输出')]);
  assert.match(merged, /```text\n## 输入格式\n!\[这是样例字符\]/);
  assert.match(merged, /## 输出格式\n\n新输出/);
});

test('replacing samples keeps local instructions after sample data and actual screenshot references', () => {
  const existing = '## 样例\n```text\n3\n1 2 3\n```\n输出 `6`。\n\n生成器通过 args[0] 接收种子。\n\n![原图](/api/images/sample.png)\n';
  const merged = mergeRecognizedStatement(existing, [section('samples', '### 输入样例 1\n\n```text\n4\n```')]);
  assert.doesNotMatch(merged, /1 2 3|输出 `6`/); assert.match(merged, /生成器通过 args\[0\] 接收种子。/);
  assert.equal(merged.match(/\/api\/images\/sample.png/g).length, 1);
});

test('unfenced samples preserve explicitly marked trailing notes while replacing old input and numeric output', () => {
  const existing = '## 样例\n输入：1 2\n输出：3\n\n99\n\n个人笔记：用 long 防止溢出。\n\n我的笔记：检查边界。\n\n生成器通过 args[0] 接收种子。\n\n## 输入格式\n旧格式\n';
  const merged = mergeRecognizedStatement(existing, [section('samples', '新的样例')]);
  assert.doesNotMatch(merged, /输入：1 2|输出：3|\n99\n/);
  assert.match(merged, /个人笔记：用 long 防止溢出。/); assert.match(merged, /我的笔记：检查边界。/);
  assert.match(merged, /生成器通过 args\[0\] 接收种子。/); assert.match(merged, /## 输入格式\n旧格式/);
});

test('replacing samples also replaces nested Input/Output headings without touching actual format sections', () => {
  const existing = '## Input\nRead n.\n\n## Samples\n### Input\n```text\n3\n```\n\n### Output\n```text\n6\n```\n\n## Notes\nKeep my note.\n';
  const merged = mergeRecognizedStatement(existing, [section('samples', '### 输入样例 1\n\n```text\n4\n```')]);
  assert.doesNotMatch(merged, /```text\n3\n```|```text\n6\n```/);
  assert.match(merged, /^## Input\nRead n./); assert.match(merged, /## Notes\nKeep my note./);
  assert.match(merged, /### 输入样例 1/);
});

test('newly recognized sections append without dropping original content, and a no-op returns the exact source', () => {
  const existing = '# 原题\r\n\r\n原描述\r\n\r\n## 其他\r\n保留\r\n';
  assert.equal(mergeRecognizedStatement(existing, []), existing);
  const merged = mergeRecognizedStatement(existing, [section('constraints', 'n <= 20'), section('notes', '保证有解')]);
  assert.ok(merged.startsWith(existing.trimEnd())); assert.match(merged, /## 数据范围\r\n\r\nn <= 20/);
  assert.match(merged, /## 提示\r\n\r\n保证有解/); assert.equal(merged.replace(/\r\n/g, '').includes('\n'), false);
});
