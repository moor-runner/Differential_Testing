import type { Folder, ProblemSummary } from './types';

export interface FolderGroup { folder: Folder; problems: ProblemSummary[]; expanded: boolean }
export interface ProblemTree { folders: FolderGroup[]; ungrouped: ProblemSummary[]; searching: boolean }

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
/** 分类按名称排序（中文按拼音、数字按大小），可用「01」「02」等前缀自定义顺序。 */
export function sortFolders(folders: Folder[]) { return [...folders].sort((a, b) => collator.compare(a.name, b.name) || a.createdAt.localeCompare(b.createdAt)); }

/**
 * 把题目摘要按分类分组，题目保持传入顺序（最近更新在前）。分类不存在的题目归入未分类。
 * 搜索时只保留标题匹配的题目；分类名匹配时保留整个分类。搜索结果中的分类总是展开，不改变保存的折叠状态。
 */
export function buildProblemTree(summaries: ProblemSummary[], folders: Folder[], query: string): ProblemTree {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  const known = new Set(folders.map(folder => folder.id));
  const groups = sortFolders(folders).flatMap(folder => {
    const inside = summaries.filter(item => item.folderId === folder.id);
    if (!needle) return [{ folder, problems: inside, expanded: !folder.collapsed }];
    const problems = matches(folder.name) ? inside : inside.filter(item => matches(item.title));
    return problems.length || matches(folder.name) ? [{ folder, problems, expanded: true }] : [];
  });
  const ungrouped = summaries.filter(item => !(item.folderId && known.has(item.folderId)) && (!needle || matches(item.title)));
  return { folders: groups, ungrouped, searching: !!needle };
}
