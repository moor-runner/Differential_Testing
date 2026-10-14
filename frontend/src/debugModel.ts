// 断点调试里与 DOM、Monaco 无关的部分：控制台增量合并、大数组分段、行内变量值与各种文字，便于单测。
import { scanJava } from './javaIntelligence.ts';
import type { DebugConsoleChunk, DebugConsoleDelta, DebugFrame, DebugRole, DebugSnapshot, DebugVariable, DebugVerdict, Job, ProcessResult } from './types';

/** Children are listed at most this many at a time; bigger containers nest ranges of this size. */
export const CHILD_PAGE = 100;

/** Sorted, distinct positive line numbers. */
export function normalizeLines(lines: Iterable<number>): number[] {
  return [...new Set([...lines].filter(line => Number.isInteger(line) && line > 0))].sort((a, b) => a - b);
}

export function sameLines(a: readonly number[], b: readonly number[]) { return a.length === b.length && a.every((line, index) => line === b[index]); }

export interface DebugConsole { chunks: DebugConsoleChunk[]; length: number; truncated: boolean }
export const emptyConsole: DebugConsole = { chunks: [], length: 0, truncated: false };

/**
 * Applies an output event. Every subscription starts at offset 0 with the whole console, so that replaces what is
 * shown; later deltas continue from the subscriber's offset. Returns null for a gap, which the caller fills by
 * fetching from its own length.
 */
export function applyConsoleDelta(previous: DebugConsole, delta: DebugConsoleDelta): DebugConsole | null {
  if (delta.from === 0) return appendChunks(emptyConsole, delta.chunks, delta.truncated);
  if (delta.from > previous.length) return null;
  let overlap = previous.length - delta.from;
  const fresh: DebugConsoleChunk[] = [];
  for (const chunk of delta.chunks) {
    if (overlap >= chunk.text.length) { overlap -= chunk.text.length; continue; }
    fresh.push(overlap ? { stream: chunk.stream, text: chunk.text.slice(overlap) } : chunk);
    overlap = 0;
  }
  return appendChunks(previous, fresh, delta.truncated);
}

function appendChunks(previous: DebugConsole, chunks: DebugConsoleChunk[], truncated: boolean): DebugConsole {
  const merged = previous.chunks.slice();
  let length = previous.length;
  for (const chunk of chunks) {
    if (!chunk.text) continue;
    const last = merged.at(-1);
    if (last?.stream === chunk.stream) merged[merged.length - 1] = { stream: last.stream, text: last.text + chunk.text };
    else merged.push({ stream: chunk.stream, text: chunk.text });
    length += chunk.text.length;
  }
  return { chunks: merged, length, truncated: previous.truncated || truncated };
}

/** A slice [start, end) of a container's children. */
export interface ChildRange { start: number; end: number }

/**
 * Up to {@link CHILD_PAGE} children show directly; larger slices split into nested ranges of 100, 10000, … so any
 * index of a million-element array is three clicks away, like VS Code's [0..9999] groups.
 */
export function childRanges(start: number, end: number): ChildRange[] | null {
  const count = end - start;
  if (count <= CHILD_PAGE) return null;
  let bucket = CHILD_PAGE;
  while (count / bucket > CHILD_PAGE) bucket *= CHILD_PAGE;
  const ranges: ChildRange[] = [];
  for (let from = start; from < end; from += bucket) ranges.push({ start: from, end: Math.min(end, from + bucket) });
  return ranges;
}

export function rangeLabel(range: ChildRange) { return `[${range.start}..${range.end - 1}]`; }

export interface InlineValue { line: number; text: string }

function clip(text: string, limit: number) { return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; }
function escapeRegExp(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * IDEA-style values after the code: every line of the frame's method from its signature down to the paused line
 * lists the variables it mentions, with their current values (not the values the line saw when it ran). Strings,
 * comments and member names after a dot are skipped.
 */
export function inlineValues(source: string, frame: Pick<DebugFrame, 'line' | 'methodStart' | 'method' | 'className'>, scope: ReadonlyMap<string, DebugVariable>, limits = { lines: 80, value: 40, text: 140 }): InlineValue[] {
  if (frame.line < 1 || !scope.size) return [];
  const code = scanJava(source).code.split(/\r\n|\r|\n/);
  let first = Math.max(1, frame.line - limits.lines, frame.methodStart > 0 && frame.methodStart <= frame.line ? frame.methodStart : frame.line);
  // The signature, just above the first line with code, declares the parameters.
  const declared = new RegExp(`\\b${escapeRegExp(frame.method === '<init>' ? frame.className : frame.method)}\\s*\\(`);
  for (let line = first - 1; line >= Math.max(1, first - 3); line--) if (declared.test(code[line - 1] ?? '')) { first = line; break; }
  const values: InlineValue[] = [];
  for (let line = first; line <= Math.min(frame.line, code.length); line++) {
    const text = code[line - 1], seen = new Set<string>(), parts: string[] = [];
    for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = match[0], before = text.slice(0, match.index).trimEnd();
      if (seen.has(name) || before.endsWith('.')) continue;
      const variable = scope.get(name);
      if (!variable || variable.kind === 'static') continue;
      seen.add(name);
      // A plain object reads as its type and id, like IDEA; its field preview belongs in the variables view.
      parts.push(`${name} = ${clip(variable.kind === 'object' ? variable.type : variable.value, limits.value)}`);
    }
    if (parts.length) values.push({ line, text: clip(parts.join(', '), limits.text) });
  }
  return values;
}

/** `fib:26`, `Node():12`, `static {}`, or `lambda（main）:8` for javac's synthetic lambda methods. */
export function frameLabel(frame: Pick<DebugFrame, 'method' | 'className' | 'line'>) {
  const lambda = /^lambda\$(.+)\$\d+$/.exec(frame.method);
  const method = frame.method === '<init>' ? `${frame.className}()` : frame.method === '<clinit>' ? 'static {}' : lambda ? `lambda（${lambda[1]}）` : frame.method;
  return frame.line > 0 ? `${method}:${frame.line}` : method;
}

export const debugVerdictLabels: Record<DebugVerdict, string> = {
  PASS: '通过', WA: '答案错误', RE: '运行错误', OLE: '输出超限', UNCHECKED: '已结束', STOPPED: '已停止', CE: '编译错误', ERROR: '调试失败',
};

export function isDebugActive(session: DebugSnapshot | null): session is DebugSnapshot { return !!session && session.state !== 'TERMINATED'; }

/** Short status for the toolbar and the top bar. */
export function debugStatus(session: DebugSnapshot): string {
  switch (session.state) {
    case 'STARTING': return session.message.includes('启动') ? '正在启动调试…' : '正在编译…';
    case 'RUNNING': return '运行中';
    case 'PAUSED': {
      const pause = session.pause, line = pause && pause.frames[pause.frameIndex]?.line;
      const where = line && line > 0 ? `第 ${line} 行` : '库代码中';
      return pause?.reason === 'exception' ? `异常 · ${where}` : `已暂停 · ${where}`;
    }
    default: return session.result ? debugVerdictLabels[session.result.verdict] : '已结束';
  }
}

function shown(value: string | null | undefined) { return value === null || value === undefined ? '（无此行）' : value === '' ? '（空行）' : clip(value, 60); }

/** What a finished session found, in the words of the test-case panel. */
export function debugResultMessage(session: DebugSnapshot): string {
  const result = session.result;
  if (!result) return session.message;
  const difference = result.firstDifference;
  switch (result.verdict) {
    case 'WA': return difference ? `第 ${difference.line} 行不同：期望 ${shown(difference.expected)}，实际 ${shown(difference.actual)}` : '输出与期望不一致';
    case 'RE': return `程序异常退出（退出码 ${result.exitCode ?? '—'}），见控制台中的 stderr`;
    case 'PASS': return '输出与期望一致';
    case 'UNCHECKED': return '程序正常结束；用例没有期望输出，未比对';
    case 'STOPPED': return '可以修改代码后重新调试（Ctrl+F5）';
    default: return result.message;
  }
}

const succeeded = (process: ProcessResult | null) => !!process && process.exitCode === 0 && !process.timedOut && !process.outputLimited;

/**
 * A failing duipai round as a case to debug: the solver at fault, with brute's output as the expected answer when
 * brute ran cleanly. Generator failures have no solver to debug.
 */
export function counterexample(job: Job): { role: DebugRole; entry: { label: string; input: string; expected: string } } | null {
  if (job.state !== 'FINISHED' || job.input === null || job.input === undefined || !job.verdict) return null;
  const role: DebugRole | null = ['WA', 'RE', 'TLE', 'OLE'].includes(job.verdict) ? 'optimized' : job.verdict === 'BRUTE_ERROR' ? 'brute' : null;
  if (!role) return null;
  return { role, entry: { label: job.seed ? `反例 · 种子 ${job.seed}` : '反例', input: job.input, expected: role === 'optimized' && succeeded(job.brute) ? job.brute!.stdout : '' } };
}
