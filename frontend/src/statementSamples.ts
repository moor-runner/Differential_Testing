/** A sample written in the statement: fenced input with its fenced (or `inline`) expected output. */
export interface StatementSample { input: string; expected: string }

type Label = 'input' | 'output' | 'explanation' | 'group';
interface Draft { input: string; expected?: string; number?: string }

const codeLanguages = new Set(['java', 'c', 'cpp', 'c++', 'cc', 'python', 'py', 'js', 'javascript', 'ts', 'typescript', 'go', 'rust', 'kotlin', 'cs', 'csharp']);

function compact(text: string) {
  return text.normalize('NFKC').toLowerCase().replace(/[`*_~#\s:.。()（）[\]【】、,，-]/g, '').replace(/\d+/g, '');
}

function numberOf(text: string) { return text.normalize('NFKC').match(/\d+/)?.[0]; }

/** Bare 输入 / Input only count inside a sample section; elsewhere they usually name the input format. */
function classify(label: string, inSamples: boolean): Label | undefined {
  const text = compact(label);
  if (!text || text.length > 16) return undefined;
  const explicit = /样例|示例|sample|example|测试/.test(text);
  if (/^(?:测试|样例|示例|sample|example)*(?:输入|input)(?:样例|示例|数据|sample|example)*$/.test(text)) return explicit || inSamples ? 'input' : undefined;
  if (/^(?:测试|样例|示例|sample|example)*(?:输出|output|期望输出|预期输出|expectedoutput)(?:样例|示例|数据|sample|example)*$/.test(text)) return explicit || inSamples ? 'output' : undefined;
  if (/^(?:样例|示例|sample|example)*(?:说明|解释|解析|explanation|notes?|提示|hints?)$/.test(text)) return explicit || inSamples ? 'explanation' : undefined;
  if (/^(?:测试样例|输入输出样例|样例输入输出|样例数据|样例|示例|samples?|examples?|sampletests?)$/.test(text)) return 'group';
  return undefined;
}

/**
 * Extract runnable samples from the Markdown statement. Recognizes the formats AI 整理 and 图片识别 write
 * (「### 样例 1 输入」「### 输入样例 1」) as well as 「输入：」 labels and unlabeled blocks under a 样例 heading.
 */
export function statementSamples(markdown: string): StatementSample[] {
  const lines = markdown.split(/\r?\n/);
  const drafts: Draft[] = [];
  let context: number | undefined;   // heading level of the enclosing sample section
  let label: Label | 'other' | undefined;
  let labelNumber: string | undefined;
  let current: Draft | undefined;

  function setLabel(next: Label | 'other' | undefined, text: string) {
    if (next === 'group') { context = context ?? 7; current = undefined; label = undefined; labelNumber = undefined; return; }
    label = next; labelNumber = next === 'input' || next === 'output' ? numberOf(text) : undefined;
  }
  function accept(block: string) {
    if (label === 'explanation' || label === 'other') return;
    if (label === undefined && context === undefined) return;
    const role = label ?? (!current || current.expected !== undefined ? 'input' : 'output');
    if (role === 'input') {
      current = { input: block, number: labelNumber };
      drafts.push(current);
    } else {
      const target = (labelNumber && drafts.find(item => item.number === labelNumber && item.expected === undefined))
        || (current?.expected === undefined ? current : undefined);
      if (target) target.expected = block;
    }
    if (label === 'input' || label === 'output') { label = undefined; labelNumber = undefined; }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/);
    if (fence) {
      const [, indent, marker, info] = fence;
      const body: string[] = [];
      let end = index + 1;
      for (; end < lines.length; end++) {
        const close = lines[end].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
        body.push(lines[end].startsWith(indent) ? lines[end].slice(indent.length) : lines[end].trimStart());
      }
      index = end;
      if (!codeLanguages.has(info.toLowerCase())) accept(body.join('\n'));
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length, kind = classify(heading[2], context !== undefined);
      if (kind === 'group') { context = level; setLabel('group', heading[2]); }
      else if (kind) setLabel(kind, heading[2]);
      else {
        if (context !== undefined && level <= context) context = undefined;
        setLabel('other', heading[2]);
      }
      continue;
    }
    const text = line.trim();
    if (!text) continue;
    // 「输出 `6`。」: a label followed by a single inline code span.
    const inline = text.match(/^(.*?)[:：]?\s*`([^`]+)`\s*[。.]?$/);
    const inlineKind = inline ? classify(inline[1], context !== undefined) : undefined;
    if (inline && (inlineKind === 'input' || inlineKind === 'output')) { setLabel(inlineKind, inline[1]); accept(inline[2]); continue; }
    const prefix = text.match(/^(.{1,24}?)[:：]/)?.[1] ?? text;
    const kind = classify(prefix, context !== undefined);
    if (kind) setLabel(kind, prefix);
  }
  return drafts.map(draft => ({ input: draft.input, expected: draft.expected ?? '' }));
}
