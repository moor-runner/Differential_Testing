import { cleanOcrText, readableProse, prepareRecognitionImage, isInterfaceNoise } from './recognitionCleanup.ts';

/** OCR rectangles are expressed in original image pixels, before preview scaling. */
export interface OcrTextBox { text: string; x: number; y: number; width: number; height: number }
export interface OcrLine extends OcrTextBox { words?: OcrTextBox[] }
export interface OcrImage { url: string; width: number; height: number; language: string; lines: OcrLine[]; focused?: boolean }
export type RecognizedSectionKind = 'title' | 'description' | 'input' | 'output' | 'samples' | 'constraints' | 'notes';
export interface RecognitionRegion { imageIndex: number; x: number; y: number; width: number; height: number }
export interface RecognizedSection { id: string; title: string; kind: RecognizedSectionKind; content: string; regions: RecognitionRegion[] }

export const recognizedSectionTitles: Record<RecognizedSectionKind, string> = {
  title: '题目标题', description: '题目描述', input: '输入格式', output: '输出格式',
  samples: '测试样例', constraints: '数据范围', notes: '提示与说明',
};

interface Heading { kind: RecognizedSectionKind; payload?: string; sampleRole?: 'input' | 'output' | 'explanation'; number?: string }
interface LocatedLine extends OcrLine { imageIndex: number; mappingHint?: RecognizedSectionKind }
interface Chunk { heading: Heading; lines: string[]; boxes: LocatedLine[] }

function headingOf(value: string): Heading | undefined {
  const text = cleanOcrText(value).replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '').replace(/^\*\*(.*?)\*\*$/, '$1')
    .replace(/^(?:[一二三四五六七八九十]+[、．.]|\d+[、．.]\s*)\s*/, '');
  const explicitTitle = text.match(/^(?:题目标题|题目名称|题目|problem\s+title|title)\s*[:：]\s*(.+)$/i);
  if (explicitTitle) return { kind: 'title', payload: explicitTitle[1].trim() };
  // Only explicit contest identifiers count as an OCR title. A short first line
  // might be a sentence, a navigation link, or a continuation from another page.
  if (/^(?:P\d{3,}\b|[A-Z]\s*[.．]\s*\S)/.test(text)) return { kind: 'title', payload: text };
  const parts = text.match(/^(.+?)(?:\s*[:：]\s*(.*))?$/);
  if (!parts) return undefined;
  const label = parts[1].trim().replace(/^[\[【（(]\s*|\s*[\]】）)]$/g, '');
  const compact = label.toLowerCase().replace(/[\s_\-]/g, '');
  const number = '(?:[#＃]?([0-9]+|[一二三四五六七八九十]+))?';
  const sampleInput = compact.match(new RegExp(`^(?:输入样例|样例输入|测试输入|sampleinput|inputsample|exampleinput|inputexample)${number}$`)) || compact.match(/^input[#＃]?([0-9]+)$/);
  if (sampleInput) return { kind: 'samples', sampleRole: 'input', number: sampleInput[1], payload: parts[2] };
  const sampleOutput = compact.match(new RegExp(`^(?:输出样例|样例输出|测试输出|sampleoutput|outputsample|exampleoutput|outputexample)${number}$`)) || compact.match(/^output[#＃]?([0-9]+)$/);
  if (sampleOutput) return { kind: 'samples', sampleRole: 'output', number: sampleOutput[1], payload: parts[2] };
  const sample = compact.match(new RegExp(`^(?:测试样例|输入输出样例|样例|samples?|examples?)${number}$`));
  if (sample) return { kind: 'samples', number: sample[1], payload: parts[2] };
  const labels: [RecognizedSectionKind, RegExp][] = [
    ['description', /^(?:题目描述|问题描述|题目背景|问题背景|题面|描述|背景|description|problemdescription|problemstatement|statement)$/],
    ['input', /^(?:输入|输入格式|输入描述|输入说明|输入规格|input|inputformat|inputspecification)$/],
    ['output', /^(?:输出|输出格式|输出描述|输出说明|输出规格|output|outputformat|outputspecification)$/],
    ['constraints', /^(?:数据范围|输入数据范围|数据范围与提示|数据范围及提示|数据范围与约束|数据范围与限制|数据范围[及与和]约定|数据限制|数据约束|约束条件|约束|限制|constraints|dataconstraints|inputconstraints|limits)$/],
    ['notes', /^(?:提示|说明|解释|解[*＊]|备注|性能要求|[解能]答要求|提示与说明|提示和说明|提示与解释|样例解释|样例说明|样例解析|hints?|notes?|explanation|sampleexplanation|explanationofthesamples?)\d*$/],
    ['title', /^(?:题目标题|题目名称|problemtitle|title)$/],
  ];
  const match = labels.find(([, expression]) => expression.test(compact));
  return match ? { kind: match[0], payload: parts[2] } : undefined;
}

function union(boxes: OcrTextBox[]): OcrTextBox {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { text: boxes.map(box => box.text).join(' '), x, y,
    width: Math.max(...boxes.map(box => box.x + box.width)) - x,
    height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}

function validBox(box: OcrTextBox): boolean {
  return typeof box.text === 'string' && box.text.trim().length > 0
    && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
}

function plainColumnHeading(line: LocatedLine): boolean {
  return /^(?:输入|输出|input|output)$/i.test(line.text.trim().replace(/^#{1,6}\s+/, '').replace(/[:：]\s*$/, '').replace(/\s/g, ''));
}

function splitColumnHeadings(line: LocatedLine, imageWidth: number): LocatedLine[] {
  const words = line.words?.filter(validBox).sort((a, b) => a.x - b.x);
  if (words?.length) {
    const groups: OcrTextBox[][] = [[]];
    for (const word of words) {
      const group = groups[groups.length - 1], previous = group[group.length - 1];
      if (previous && word.x - previous.x - previous.width > Math.max(24, imageWidth * 0.05)) groups.push([]);
      groups[groups.length - 1].push(word);
    }
    const split = groups.map(group => ({ ...union(group), imageIndex: line.imageIndex, words: group }));
    if (split.length === 2 && split.every(item => ['input', 'output'].includes(headingOf(item.text)?.sampleRole || headingOf(item.text)?.kind || ''))) return split;
  }
  // Some OCR engines keep columns in a single line but retain their whitespace.
  const pieces = line.text.trim().split(/\s{3,}/);
  if (pieces.length === 2 && pieces.every(piece => ['input', 'output'].includes(headingOf(piece)?.sampleRole || headingOf(piece)?.kind || ''))) {
    return pieces.map((text, index) => ({ ...line, text, x: line.x + index * line.width / 2, width: line.width / 2, words: undefined }));
  }
  return [line];
}

function splitAt(line: LocatedLine, boundary: number): LocatedLine[] {
  const words = line.words?.filter(validBox);
  if (words?.length) {
    const left = words.filter(word => word.x + word.width / 2 < boundary), right = words.filter(word => word.x + word.width / 2 >= boundary);
    if (left.length && right.length) return [left, right].map(group => ({ ...union(group.sort((a, b) => a.x - b.x)), imageIndex: line.imageIndex, words: group }));
  }
  const pieces = line.text.trim().split(/\s{3,}/);
  if (pieces.length === 2 && line.x < boundary && line.x + line.width > boundary) {
    return [{ ...line, text: pieces[0], width: boundary - line.x }, { ...line, text: pieces[1], x: boundary, width: line.x + line.width - boundary }];
  }
  return [line];
}

/** Put side-by-side sample columns in input/output order instead of OCR row order. */
function readingOrder(image: OcrImage, imageIndex: number): LocatedLine[] {
  const lines = image.lines.filter(validBox).flatMap(line => splitColumnHeadings({ ...line, imageIndex }, image.width))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: LocatedLine[][] = [];
  for (const line of lines) {
    const row = rows[rows.length - 1], anchor = row?.[0];
    if (anchor && Math.abs(line.y + line.height / 2 - anchor.y - anchor.height / 2) <= Math.max(2, Math.min(line.height, anchor.height) * 0.65)) row.push(line);
    else rows.push([line]);
  }
  const result: LocatedLine[] = [];
  let columns: { left: LocatedLine[]; right: LocatedLine[]; boundary: number } | undefined;
  const flush = () => {
    if (columns) {
      const leftHeading = headingOf(columns.left[0].text);
      const leftIsInput = leftHeading?.sampleRole === 'input' || leftHeading?.kind === 'input';
      result.push(...(leftIsInput ? columns.left : columns.right), ...(leftIsInput ? columns.right : columns.left)); columns = undefined;
    }
  };
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const inputs = row.filter(line => { const heading = headingOf(line.text); return heading?.sampleRole === 'input' || heading?.kind === 'input'; });
    const outputs = row.filter(line => { const heading = headingOf(line.text); return heading?.sampleRole === 'output' || heading?.kind === 'output'; });
    if (inputs.length === 1 && outputs.length === 1) {
      const inputHeading = headingOf(inputs[0].text)!, outputHeading = headingOf(outputs[0].text)!;
      const sampleColumns = (inputHeading.sampleRole || plainColumnHeading(inputs[0])) && (outputHeading.sampleRole || plainColumnHeading(outputs[0]));
      const formatColumns = inputHeading.kind === 'input' && outputHeading.kind === 'output' && !plainColumnHeading(inputs[0]) && !plainColumnHeading(outputs[0]);
      if (!sampleColumns && !formatColumns) { flush(); result.push(...row); continue; }
      flush();
      const left = inputs[0].x < outputs[0].x ? inputs[0] : outputs[0], right = left === inputs[0] ? outputs[0] : inputs[0];
      // Keep a third caption on the header row rather than dropping it when
      // converting the two columns into their semantic reading order.
      result.push(...row.filter(line => line !== left && line !== right).map(line => ({ ...line, mappingHint: 'notes' as const })));
      if (sampleColumns && !inputHeading.sampleRole) inputs[0].text = '输入样例';
      if (sampleColumns && !outputHeading.sampleRole) outputs[0].text = '输出样例';
      columns = { left: [left], right: [right], boundary: (left.x + left.width / 2 + right.x + right.width / 2) / 2 };
      continue;
    }
    if (columns && row.some(line => headingOf(line.text))) flush();
    if (columns) {
      for (const line of row.flatMap(item => splitAt(item, columns!.boundary))) {
        (line.x + line.width / 2 < columns.boundary ? columns.left : columns.right).push(line);
      }
    } else result.push(...row);
  }
  flush();
  return result;
}

function codeBlock(content: string): string {
  const runs = content.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}text\n${content}\n${fence}`;
}

function proseText(content: string): string {
  return content.split(/\r?\n/).map(cleanOcrText).join('\n');
}

/** Detect editable semantic sections and retain the rectangles behind every section. */
export function parseRecognizedStatement(images: OcrImage[]): RecognizedSection[] {
  const chunks: Chunk[] = [];
  let current: Chunk | undefined, sampleNumber = 0, lastInputNumber = '', sampleContext = false, sampleGroupNumber: string | undefined;
  const begin = (heading: Heading, line?: LocatedLine) => {
    if (heading.kind === 'samples') {
      if (!heading.sampleRole) sampleGroupNumber = heading.number;
      else if (!heading.number && sampleGroupNumber) heading.number = sampleGroupNumber;
      if (heading.number) { sampleNumber = Math.max(sampleNumber, Number(heading.number) || sampleNumber); }
      else if (heading.sampleRole === 'input') heading.number = String(++sampleNumber);
      else if (heading.sampleRole === 'output' || heading.sampleRole === 'explanation') heading.number = lastInputNumber || String(++sampleNumber);
      if (heading.sampleRole === 'input') lastInputNumber = heading.number || '';
    }
    current = { heading, lines: heading.payload?.trim() ? [heading.payload.trim()] : [], boxes: line ? [line] : [] };
    chunks.push(current);
  };
  images.forEach((image, imageIndex) => {
    const prepared = prepareRecognitionImage(image);
    const ordered = readingOrder(prepared.image, imageIndex);
    for (let lineIndex = 0; lineIndex < ordered.length; lineIndex++) {
      const line = ordered[lineIndex];
      if (line.mappingHint) {
        sampleContext = false; sampleGroupNumber = undefined;
        begin({ kind: line.mappingHint }, line); current!.lines.push(line.text.trimEnd()); continue;
      }
      let heading = headingOf(line.text);
      if (!heading && !sampleContext && /^输入(?:数字|一个整数|整数)/.test(line.text)) heading = { kind: 'input', payload: line.text };
      const next = ordered[lineIndex + 1];
      const numberedTitle = line.text.match(/^\d+\s*[、.．]\s*(.{2,60})$/);
      if (!heading && numberedTitle && prepared.focused && lineIndex < 4 && !/[。！？；]$/.test(line.text)) {
        heading = { kind: 'title', payload: numberedTitle[1] };
      }
      // A larger single first line followed by a section heading is a useful
      // title signal, while ordinary unheaded text remains a description.
      if (!heading && imageIndex === 0 && lineIndex === 0 && next && line.text.trim().length <= 120
        && !/[。！？:：]$/.test(line.text.trim())
        && ((headingOf(next.text)?.kind === 'description' && line.height >= next.height * 1.1)
          || (line.height >= next.height * 1.4 && ordered.slice(1, 20).some(item => headingOf(item.text))))) {
        heading = { kind: 'title', payload: proseText(line.text.trim()) };
      }
      if (heading) {
        if (sampleContext && heading.kind === 'notes' && /^(?:解释|解[*＊]|说明|样例解释|样例说明|explanation|note)(?:[:：].*)?$/i.test(line.text.replace(/\s/g, ''))) {
          heading = { ...heading, kind: 'samples', sampleRole: 'explanation' };
        }
        if (sampleContext && (heading.kind === 'input' || heading.kind === 'output')
          && /^(?:输入|输出|input|output)(?:[:：].*)?$/i.test(line.text.trim().replace(/\s/g, ''))) {
          heading = { ...heading, sampleRole: heading.kind, kind: 'samples' };
        }
        sampleContext = heading.kind === 'samples';
        if (!sampleContext) sampleGroupNumber = undefined;
        begin(heading, line); continue;
      }
      if (!current || (current.heading.kind === 'title' && current.lines.length)) begin({ kind: 'description' });
      current!.lines.push(line.text.trimEnd()); current!.boxes.push(line);
    }
  });
  const sections = new Map<RecognizedSectionKind, RecognizedSection>();
  for (const chunk of chunks) {
    const raw = chunk.lines.join('\n').trim();
    if (!raw) continue; // Empty OCR headings must never erase an existing section.
    const kind = chunk.heading.kind;
    let content = kind === 'samples' ? raw : proseText(raw);
    if (kind !== 'title' && kind !== 'samples' && kind !== 'constraints') content = readableProse(content);
    if (kind === 'samples') {
      const label = chunk.heading.sampleRole === 'explanation' ? `样例${chunk.heading.number ? ` ${chunk.heading.number}` : ''}说明` : chunk.heading.sampleRole ? `${chunk.heading.sampleRole === 'input' ? '输入' : '输出'}样例${chunk.heading.number ? ` ${chunk.heading.number}` : ''}`
        : `样例${chunk.heading.number ? ` ${chunk.heading.number}` : ''}`;
      content = `### ${label}\n\n${chunk.heading.sampleRole === 'explanation' ? readableProse(raw) : codeBlock(raw)}`;
    }
    let section = sections.get(kind);
    if (!section) { section = { id: `recognized-${kind}`, kind, title: recognizedSectionTitles[kind], content: '', regions: [] }; sections.set(kind, section); }
    section.content += `${section.content ? '\n\n' : ''}${content}`;
    for (const imageIndex of new Set(chunk.boxes.map(box => box.imageIndex))) {
      const bounds = union(chunk.boxes.filter(box => box.imageIndex === imageIndex));
      section.regions.push({ imageIndex, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    }
  }
  const input = sections.get('input');
  if (input) {
    const rangePattern = /\b\d+(?:\s*\^\s*\d+)?\s*(?:<=|≤|<)\s*[a-zA-Z][a-zA-Z0-9_]*(?:\s*(?:<=|≤|<)\s*\d+(?:\s*\^\s*\d+)?)?/g;
    const ranges = input.content.match(rangePattern);
    if (ranges?.length && /输入数字|输入一个整数/.test(input.content)) {
      input.content = input.content.replace(rangePattern, '').replace(/[，,；;（(]\s*[）)]|[，,；;]\s*$/g, '').trim();
      const existing = sections.get('constraints');
      const content = [...new Set(ranges)].join('\n');
      if (existing) existing.content += `\n\n${content}`;
      else sections.set('constraints', { id: 'recognized-constraints', kind: 'constraints', title: recognizedSectionTitles.constraints, content, regions: input.regions.map(region => ({ ...region })) });
    }
  }
  return [...sections.values()];
}

/** Reformat existing OCR Markdown without touching images or independent notes. */
export function cleanRecognizedStatement(existing: string): string {
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const headings = markdownHeadings(existing);
  const format = (body: string, kind: RecognizedSectionKind) => {
    const parts: string[] = [], prose: string[] = [];
    let fence: { marker: string; length: number } | undefined;
    const flush = () => {
      const text = prose.filter(line => !(line.length < 200 && isInterfaceNoise(line))).join('\n');
      if (text.trim()) parts.push(kind === 'samples' || kind === 'constraints' ? text.trim() : readableProse(text));
      prose.length = 0;
    };
    for (const line of body.split(/\r?\n/)) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,}|\$\$(?=\s*$))/);
      if (marker) {
        flush(); parts.push(line);
        if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = undefined;
      } else if (fence) parts.push(line);
      else if (/^\s*!\[|^\s*\[[^\]]+\]:|^\s*#{1,6}\s|^\s*(?:[-*+]\s|\d+\.\s|[|>])/.test(line)) { flush(); parts.push(line); }
      else prose.push(line);
    }
    flush();
    return parts.join('\n').trim().replace(/\n/g, newline);
  };
  let result = existing;
  for (const heading of [...headings].reverse()) {
    if (!heading.kind || heading.kind === 'title') continue;
    const body = existing.slice(heading.lineEnd, heading.end);
    result = result.slice(0, heading.lineEnd) + newline + format(body, heading.kind) + newline + newline + result.slice(heading.end);
  }
  if (!headings.length) return format(existing, 'description') + newline;
  const first = headings[0];
  if (first.kind === 'title' && !headings.some(heading => heading.kind === 'description')) {
    result = result.slice(0, first.lineEnd) + newline + format(existing.slice(first.lineEnd, first.end), 'description') + newline + newline + result.slice(first.end);
  }
  return result.trimEnd() + newline;
}

export interface MarkdownHeading { start: number; lineEnd: number; end: number; prefix: string; label: string; kind?: RecognizedSectionKind; level: number }

export function markdownHeadings(text: string): MarkdownHeading[] {
  const result: MarkdownHeading[] = [];
  const rows = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0]);
  let fence: { marker: string; length: number } | undefined;
  let sampleParentLevel: number | undefined;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], line = row[0].replace(/\r?\n$/, ''), marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const atx = line.match(/^(\s{0,3}#{1,6})\s+(.+?)\s*#*\s*$/);
    const underline = rows[index + 1]?.[0].replace(/\r?\n$/, '').match(/^\s{0,3}(=+|-+)\s*$/);
    const semantic = headingOf(line);
    if (!atx && !(line.trim() && underline) && (!semantic || semantic.payload)) continue;
    const label = atx ? atx[2] : line.trim(), level = atx ? atx[1].trim().length : underline ? (underline[1][0] === '=' ? 1 : 2) : 2;
    const classified = headingOf(label);
    let kind = classified?.kind || (result.length === 0 && level === 1 ? 'title' : undefined);
    if (sampleParentLevel !== undefined && (kind === 'input' || kind === 'output')
      && (level > sampleParentLevel || (!atx && !underline)) && /^(?:输入|输出|input|output)$/i.test(label.replace(/\s/g, ''))) kind = 'samples';
    else if (sampleParentLevel !== undefined && level <= sampleParentLevel) sampleParentLevel = undefined;
    if (kind === 'samples' && !classified?.sampleRole && sampleParentLevel === undefined) sampleParentLevel = level;
    const lineEnd = underline && !atx ? rows[++index].index! + rows[index][0].length : row.index! + row[0].length;
    result.push({ start: row.index!, lineEnd, end: text.length, prefix: atx ? atx[1] : '#'.repeat(level), label, level, kind });
  }
  result.forEach((heading, index) => { heading.end = result[index + 1]?.start ?? text.length; });
  return result;
}

function preservedImages(content: string): string {
  const images: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    images.push(...(line.match(/!\[(?:\\.|[^\]\\])*\](?:\((?:\\.|[^)\n])*\)|\[[^\]\n]*\])/g) || []));
    if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(line)) images.push(line);
  }
  return images.join('\n');
}

// Preserve only explicitly marked personal notes and local generator instructions.
// Other prose or numeric output can be old sample content and must be replaced.
function sampleTail(body: string): string {
  const endings = [...body.matchAll(/^\s{0,3}(?:`{3,}|~{3,})\s*\r?$/gm)];
  const last = endings[endings.length - 1];
  const after = (last ? body.slice(last.index! + last[0].length) : body).trim();
  return after.split(/\r?\n\s*\r?\n/).filter(paragraph => /^(?:个人笔记|我的笔记|生成器)/.test(paragraph.trim())
    && !(/生成器通过[\s\S]*args\[0\]/.test(paragraph) && /三个编辑器[\s\S]*public class Main/.test(paragraph))).join('\n\n');
}

/** Replace only mapped sections; keep unselected sections, other headings, and original images. */
export function mergeRecognizedStatement(existing: string, sections: RecognizedSection[]): string {
  if (!sections.length) return existing;
  const incoming = new Map<RecognizedSectionKind, { title: string; content: string }>();
  for (const section of sections) {
    const prior = incoming.get(section.kind);
    if (prior) prior.content += `\n\n${section.content.trim()}`;
    else incoming.set(section.kind, { title: section.title, content: section.content.trim() });
  }
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  const normalize = (value: string) => value.replace(/\r?\n/g, newline);
  const headings = markdownHeadings(existing), consumed = new Set<RecognizedSectionKind>();
  const patches: { start: number; end: number; text: string }[] = [];
  const replacement = (kind: RecognizedSectionKind, body: string, heading?: MarkdownHeading) => {
    const section = incoming.get(kind)!;
    const first = !consumed.has(kind); consumed.add(kind);
    const images = preservedImages(body), tail = kind === 'samples' ? sampleTail(body) : '';
    const preserved = [tail, images].filter(Boolean).join('\n\n');
    // Remove duplicated images when a preserved sample tail already contains them.
    const kept = tail ? `${tail}${images ? `\n\n${images.split('\n').filter(image => !tail.includes(image)).join('\n')}` : ''}`.trim() : preserved;
    const content = first ? section.content : '';
    const header = first && heading ? `${heading.prefix} ${heading.label}\n\n` : '';
    return normalize(`${header}${[content, kept].filter(Boolean).join('\n\n')}${content || kept || header ? '\n\n' : ''}`);
  };
  const firstHeading = headings[0], hasExplicitDescription = headings.some(heading => heading.kind === 'description');
  const preambleEnd = firstHeading?.start ?? existing.length;
  if (incoming.has('description') && !hasExplicitDescription && existing.slice(0, preambleEnd).trim()) patches.push({ start: 0, end: preambleEnd, text: replacement('description', existing.slice(0, preambleEnd)) });
  for (const heading of headings) {
    if (heading.kind === 'title') {
      const title = incoming.get('title');
      if (title && !consumed.has('title')) {
        patches.push({ start: heading.start, end: heading.lineEnd, text: normalize(`# ${title.content.replace(/\r?\n/g, ' ').trim()}\n`) }); consumed.add('title');
      }
      if (incoming.has('description') && !hasExplicitDescription && !consumed.has('description') && existing.slice(heading.lineEnd, heading.end).trim()) {
        patches.push({ start: heading.lineEnd, end: heading.end, text: `${newline}${replacement('description', existing.slice(heading.lineEnd, heading.end))}` });
      }
    } else if (heading.kind && incoming.has(heading.kind)) {
      patches.push({ start: heading.start, end: heading.end, text: replacement(heading.kind, existing.slice(heading.lineEnd, heading.end), heading) });
    }
  }
  let result = existing;
  for (const patch of patches.sort((a, b) => b.start - a.start)) result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
  // Insert a missing title at the beginning, and missing body sections at the end.
  const title = incoming.get('title');
  if (title && !consumed.has('title')) { result = normalize(`# ${title.content.replace(/\r?\n/g, ' ')}\n\n`) + result; consumed.add('title'); }
  const appended: string[] = [];
  for (const [kind, section] of incoming) if (!consumed.has(kind)) appended.push(`## ${section.title || recognizedSectionTitles[kind]}\n\n${section.content}`);
  if (appended.length) result = `${result.trimEnd()}${result.trimEnd() ? `${newline}${newline}` : ''}${normalize(appended.join('\n\n'))}${newline}`;
  return result;
}
