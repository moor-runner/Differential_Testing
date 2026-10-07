import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRecognitionImage, refineRecognitionImage, readableProse } from '../src/recognitionCleanup.ts';
import { parseRecognizedStatement, mergeRecognizedStatement, cleanRecognizedStatement } from '../src/statementRecognition.ts';

const box = (text, y, x = 400, width = 650, height = 24) => ({text, x, y, width, height});
const image = lines => ({url: '/api/images/source.png', width: 3000, height: 1800, language: 'zh-Hans-CN', lines});
const exam = () => image([
  box('【校园招聘】 软件开发工程师', 20, 40), box('姓名：测试用户', 100, 40), box('考号：SR2026000000000', 150, 40),
  box('1、数字消除游戏', 180, 400, 250, 34), box('列表 arr 包含范围 [1, n] 中的', 245), box('所有整数。', 280),
  box('从左到右删除第一个数字。', 330), box('重复步骤，直到剩下一个数字。', 370),
  box('输入', 440), box('输入数字 n，1 <= n <= 1000000', 490), box('输出', 550), box('输出最后剩下的数字。', 600),
  box('样例1', 680), box('复制 输入：1', 730), box('复制 输出：1', 780), box('解释：arr = [1]', 830),
  box('样例2', 900), box('复制 输入：9', 950), box('复制 输出：6', 1000), box('解 ． 释：arr = [2, 6]', 1050),
  box('SR2026000000000', 1120, 600, 300, 50), box('提交代码', 1650, 1400),
  ...['import java.util.*;', 'public class Main {', 'public static void main(String[] args) {', 'int n=9;', 'for (int i=0;i<n;i++) {', 'System.out.println(n);', '}', '}'].map((text,i) => box(text, 200 + i * 40, 1450)),
  ...Array.from({length: 12}, (_, i) => box(String(i + 1), 200 + i * 40, 1390, 30)),
]);
test('exam screenshot selects the problem column and removes UI, watermarks and editor gutter', () => {
  const source = exam();
  const prepared = prepareRecognitionImage(source);
  assert.equal(prepared.focused, true);
  assert.ok(prepared.region.x > 300 && prepared.region.x + prepared.region.width < 1400);
  const sections = Object.fromEntries(parseRecognizedStatement([source]).map(section => [section.kind, section]));
  assert.equal(sections.title.content, '数字消除游戏');
  assert.equal(sections.description.content, '列表 arr 包含范围 [1, n] 中的所有整数。\n\n从左到右删除第一个数字。\n\n重复步骤，直到剩下一个数字。');
  assert.equal(sections.input.content, '输入数字 n');
  assert.equal(sections.constraints.content, '1 <= n <= 1000000');
  assert.match(sections.samples.content, /输出样例 2\n\n```text\n6\n```/);
  assert.match(sections.samples.content, /样例 2说明\n\narr = \[2, 6\]/);
  assert.doesNotMatch(JSON.stringify(sections), /姓名|考号|SR2026|提交代码|public class|java.util|复制/);
  assert.ok(Object.values(sections).flatMap(section => section.regions).every(region => region.x >= 300 && region.x + region.width < 1400));
});
test('ordinary statements keep legitimate pseudocode and short sample numbers', () => {
  const source = image([box('题目描述', 100, 20), box('public class Main 是本题要求的类名。', 150, 20), box('输入格式', 200, 20), box('n', 240, 20), box('输出格式', 280, 20), box('答案', 320, 20), box('样例输入', 380, 20), box('95', 420, 20)]);
  assert.equal(prepareRecognitionImage(source).focused, false);
  const sections = parseRecognizedStatement([source]);
  assert.match(sections.find(section => section.kind === 'description').content, /public class Main/);
  assert.match(sections.find(section => section.kind === 'samples').content, /\n95\n/);
});
test('focused enhancement keeps complete original bounds, timing and array rows without duplicating them', () => {
  const primary = exam();
  primary.lines.push(box('时间限制：2000ms', 410), box('arr = [6]', 1090));
  const focused = image([box('输入数字 n，1 <= n <= 100', 490), box('时间限制：20ms', 410), box('arr', 1090)]);
  const refined = refineRecognitionImage(primary, focused);
  assert.ok(refined.focused);
  assert.equal(refined.lines.filter(line => line.text.includes('1000000')).length, 1);
  assert.equal(refined.lines.find(line => line.y === 410).text, '时间限制：2000ms');
  assert.equal(refined.lines.find(line => line.y === 1090).text, 'arr = [6]');
});
test('formatting joins wrapped prose but separates complete sentences and individual input rows', () => {
  assert.equal(readableProse('给 定 n 个整\n数，求和。\n输出答案。'), '给定 n 个整数，求和。\n\n输出答案。');
  assert.equal(readableProse('Read n\nintegers.\nPrint the sum.'), 'Read n integers.\n\nPrint the sum.');
  assert.equal(readableProse('第一行输入 n。\n第二行输入数组。'), '第一行输入 n。\n\n第二行输入数组。');
});
test('organizing Markdown preserves unknown headings, personal notes, images and exact fenced sample data', () => {
  const sample = '```text\n1  2\n\n\n3\n```';
  const table = '| 变量 | 范围 |\n| --- | --- |\n| n | 1 到 10 |';
  const formula = '$$\nf(n) =\n  n + 1\n$$';
  const original = `# 原题\n\n## 题目描述\n给 定 n 个整\n数。\n\n${formula}\n\n## 我的思路\n我的  原文\n\n## 数据范围\n${table}\n\n## 样例\n${sample}\n\n![原图](/api/images/source.png)\n\n## 自定义附件\n保留这段内容。\n`;
  const formatted = cleanRecognizedStatement(original);
  assert.match(formatted, /给定 n 个整数。/);
  assert.ok(formatted.includes(sample));
  assert.ok(formatted.includes(table)); assert.ok(formatted.includes(formula));
  assert.match(formatted, /## 我的思路\n我的  原文/);
  assert.match(formatted, /## 自定义附件\n保留这段内容。/);
  assert.equal(formatted.match(/\/api\/images\/source.png/g).length, 1);
});
test('replacing messy OCR removes the original template boilerplate while preserving custom generator notes', () => {
  const original = '## 样例\n```text\n旧样例\n```\n\n生成器通过 `args[0]` 接收种子。三个编辑器中的程序都应为 `public class Main`。\n\n我的笔记：边界检查。\n';
  const section = {id:'samples',kind:'samples',title:'测试样例',content:'新的样例',regions:[]};
  const merged = mergeRecognizedStatement(original, [section]);
  assert.doesNotMatch(merged, /三个编辑器|生成器通过/);
  assert.match(merged, /我的笔记：边界检查。/);
});
