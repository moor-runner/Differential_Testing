import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProblemTree, sortFolders } from '../src/problemTree.ts';

const folder = (id, name, collapsed = false, createdAt = '2026-01-01T00:00:00Z') => ({ id, name, collapsed, createdAt });
const problem = (id, title, folderId = null) => ({ id, title, updatedAt: '2026-01-01T00:00:00Z', folderId });
const ids = items => items.map(item => item.id);

test('groups problems by folder, keeps list order and treats unknown folders as ungrouped', () => {
  const folders = [folder('dp', '动态规划'), folder('graph', '图论', true)];
  const summaries = [problem('a', '背包', 'dp'), problem('b', 'A+B'), problem('c', '最短路', 'graph'), problem('d', '区间DP', 'dp'), problem('e', '孤儿', 'deleted')];
  const tree = buildProblemTree(summaries, folders, '');
  assert.equal(tree.searching, false);
  assert.deepEqual(tree.folders.map(group => [group.folder.id, ids(group.problems), group.expanded]), [['dp', ['a', 'd'], true], ['graph', ['c'], false]]);
  assert.deepEqual(ids(tree.ungrouped), ['b', 'e']);
});

test('keeps empty folders visible so problems can be dropped into them', () => {
  const tree = buildProblemTree([problem('a', 'A+B')], [folder('empty', '待做')], '');
  assert.deepEqual(tree.folders.map(group => [group.folder.id, group.problems.length]), [['empty', 0]]);
});

test('search filters titles, keeps whole folder when its name matches and expands matches', () => {
  const folders = [folder('dp', '动态规划', true), folder('graph', '图论', true), folder('misc', '杂题')];
  const summaries = [problem('a', '背包 DP', 'dp'), problem('b', '数位dp'), problem('c', '最短路', 'graph'), problem('d', '线段树', 'dp'), problem('e', '模拟', 'misc')];
  const byTitle = buildProblemTree(summaries, folders, ' dp ');
  assert.equal(byTitle.searching, true);
  assert.deepEqual(byTitle.folders.map(group => [group.folder.id, ids(group.problems), group.expanded]), [['dp', ['a'], true]]);
  assert.deepEqual(ids(byTitle.ungrouped), ['b']);
  const byFolder = buildProblemTree(summaries, folders, '图论');
  assert.deepEqual(byFolder.folders.map(group => [group.folder.id, ids(group.problems)]), [['graph', ['c']]]);
  assert.deepEqual(byFolder.ungrouped, []);
});

test('sorts folder names naturally with Chinese and numeric prefixes', () => {
  const sorted = sortFolders([folder('3', '10 周赛'), folder('1', '2 周赛'), folder('2', 'Codeforces'), folder('4', 'atcoder')]);
  assert.deepEqual(sorted.map(item => item.name), ['2 周赛', '10 周赛', 'atcoder', 'Codeforces']);
});
