import type { OcrImage, OcrLine, OcrTextBox } from './statementRecognition';

const han = '\\u3400-\\u9fff';
const watermark = /(?:[S5]\s*[R2]|[0O]\s*R)\s*\d(?:[\s.．\\]*[0-9A-Za-z]){6,18}/gi;

export function cleanOcrText(text: string): string {
  return text.replace(/\u00a0|\u3000/g, ' ')
    .replace(new RegExp(`(?<=[${han}])[^\\S\\r\\n]+(?=[${han}])`, 'g'), '')
    .replace(/[^\S\r\n]*([，。：；！？、])[^\S\r\n]*/g, '$1')
    .replace(/([<>])[^\S\r\n]+=/g, '$1=')
    .replace(/([（【])[^\S\r\n]+/g, '$1').replace(/[^\S\r\n]+([）】])/g, '$1')
    .replace(/^复制\s*(?=(?:输入|输出|样例|解释|说明))/g, '')
    .replace(/^copy\s*(?=(?:input|output))/i, '')
    .replace(/^(?:[0O过]?制|复制)\s*(?=(?:输入|输出)[:：])/g, '')
    .replace(/^解\s*[.．。]\s*释\s*[:：．。]?/, '解释：')
    .replace(/^解释[．。]\s*/, '解释：')
    .replace(/^(输入|输出)[．。]\s*/, '$1：').trim();
}

export function isInterfaceNoise(text: string): boolean {
  const compact = cleanOcrText(text).replace(/\s/g, '');
  return /^(?:姓名|考号|准考证号|考生编号|账号)[:：]/.test(compact)
    || /^(?:[〖【\[].*(?:校园招聘|招聘笔试|招聘考试).*[〗】\]]|[〖【\[].*(?:校园招聘|招聘笔试|招聘考试))/.test(compact)
    || /^(?:满分[:：]|已答[:：]?\d|未答[:：]?\d|剩余时间[:：]?|第[\d一二三四五六七八九十]+题[（(]\d+分[）)]|编程题(?:\d+题|第?\d+\/\d+题)?$)/.test(compact)
    || /^(?:交卷|提交代码|执行代码|是否自动跳到下一题|下一题|存疑|控制台|重置|Java(?:重置)?)[。．、:：\d]*$/i.test(compact)
    || /当前.{0,4}程题尚未提交|请点击右下角提交代码/.test(compact);
}

export function isEditorCode(text: string): boolean {
  const compact = cleanOcrText(text).replace(/[．。]/g, '.').replace(/[（〈]/g, '(').replace(/[）〉]/g, ')');
  return /^\s*(?:\d{1,4}\s+)?(?:[il]mport\s|package\s|(?:public|private|protected)\s|(?:int|boolean|long|double|String|Scanner|BufferedReader|List)\s*[<(a-zA-Z]|(?:if|for|while)\s*\(|System\s*\.|(?:list|curlndex|curIndex|directFlag)\s*[.=(+\-]|\/\/|[{}]\s*$)/i.test(compact);
}

function bounds(words: OcrTextBox[]): OcrLine {
  const x = Math.min(...words.map(word => word.x)), y = Math.min(...words.map(word => word.y));
  return { text: cleanOcrText(words.map(word => word.text).join(' ')), x, y,
    width: Math.max(...words.map(word => word.x + word.width)) - x,
    height: Math.max(...words.map(word => word.y + word.height)) - y, words };
}

/** Separate distant UI columns and slanted watermark words before semantic parsing. */
function visualLines(line: OcrLine, imageWidth: number): OcrLine[] {
  if (!line.words?.length) return [{ ...line, text: cleanOcrText(line.text) }];
  const words = line.words.filter(word => word.text.trim() && word.width > 0 && word.height > 0);
  if (!words.length) return [];
  const heights = words.map(word => word.height).sort((a, b) => a - b);
  const normalHeight = heights[Math.floor(heights.length / 2)];
  const rows: OcrTextBox[][] = [];
  if (line.height <= normalHeight * 1.6) rows.push(words);
  for (const word of rows.length ? [] : [...words].sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2)) {
    const row = rows.find(group => Math.abs(group[0].y + group[0].height / 2 - word.y - word.height / 2) <= Math.max(5, normalHeight * 0.6));
    if (row) row.push(word); else rows.push([word]);
  }
  const result: OcrLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const groups: OcrTextBox[][] = [[]];
    for (const word of row) {
      const group = groups[groups.length - 1], previous = group[group.length - 1];
      if (previous && word.x - previous.x - previous.width > Math.max(normalHeight * 3, imageWidth * 0.018)) groups.push([]);
      groups[groups.length - 1].push(word);
    }
    result.push(...groups.filter(group => group.length).map(bounds));
  }
  return result;
}

function anchorKind(text: string): string | undefined {
  const label = cleanOcrText(text).replace(/\s/g, '').replace(/[:：].*$/, '').toLowerCase();
  if (/^(?:输入(?:格式|描述|说明)?|input(?:format)?)$/.test(label)) return 'input';
  if (/^(?:输出(?:格式|描述|说明)?|output(?:format)?)$/.test(label)) return 'output';
  if (/^(?:样例|示例|测试样例|输入样例|输出样例|样例输入|样例输出|sample(?:input|output)?|example)[#＃]?\d*$/.test(label)) return 'samples';
  if (/^(?:数据范围|输入数据范围|constraints|题目描述|问题描述)$/.test(label)) return label;
  return undefined;
}

function removeWatermark(text: string): string {
  const hadWatermark = watermark.test(text); watermark.lastIndex = 0;
  const cleaned = cleanOcrText(text.replace(watermark, ''));
  watermark.lastIndex = 0;
  if (hadWatermark && /^[\s\p{P}\p{S}\d\u3400-\u9fff]{0,12}$/u.test(cleaned)) return '';
  return cleaned;
}

export interface PreparedRecognition { image: OcrImage; removedLines: number; focused: boolean; region?: { x: number; y: number; width: number; height: number } }

export function prepareRecognitionImage(image: OcrImage): PreparedRecognition {
  const split = image.lines.flatMap(line => visualLines(line, image.width));
  const anchors = split.filter(line => anchorKind(line.text));
  const candidates = anchors.map(anchor => {
    const group = anchors.filter(line => Math.abs(line.x - anchor.x) <= Math.max(image.width * 0.025, anchor.height * 3));
    return { group, score: new Set(group.map(line => anchorKind(line.text))).size * 10 + group.length };
  }).sort((a, b) => b.score - a.score);
  const main = candidates[0]?.group;
  const code = split.filter(line => isEditorCode(line.text));
  let left = 0, right = image.width, focused = false;
  if (main && main.length >= 3 && new Set(main.map(line => anchorKind(line.text))).size >= 2) {
    const xs = main.map(line => line.x).sort((a, b) => a - b);
    const anchorX = xs[Math.floor(xs.length / 2)];
    const externalCode = code.filter(line => line.x > anchorX + image.width * 0.13);
    // A column is only selected when a distinct editor actually exists. A
    // standalone statement, including legitimate pseudocode, keeps its width.
    if (externalCode.length >= 4) {
      left = Math.max(0, anchorX - Math.max(main[0].height * 2, image.width * 0.012));
      const starts = externalCode.map(line => line.x).sort((a, b) => a - b);
      right = starts[Math.floor(starts.length * 0.1)] - main[0].height * 0.3;
      const numbers = split.filter(line => /^\d{1,4}$/.test(line.text.trim()) && line.x > anchorX + image.width * 0.13 && line.x < right + image.width * 0.04);
      const gutter = numbers.find(number => numbers.filter(line => Math.abs(line.x - number.x) < main[0].height * 1.5).length >= 8);
      if (gutter) right = Math.min(right, gutter.x - main[0].height);
      focused = right - left > image.width * 0.1;
      if (!focused) { left = 0; right = image.width; }
    }
  }
  focused ||= image.focused === true;
  const interfaceImage = focused || split.filter(line => isInterfaceNoise(line.text)).length >= 3;
  const firstTitle = focused ? split.find(line => line.x >= left && line.x < right && /^\d+\s*[、.．]\s*.{2,60}$/.test(cleanOcrText(line.text)) && !/[。！？；]$/.test(line.text)) : undefined;
  const clean: OcrLine[] = [];
  for (const line of split) {
    if (firstTitle && line.y + line.height < firstTitle.y) continue;
    if (focused && (line.x + line.width / 2 < left || line.x >= right || line.x + line.width / 2 > right)) continue;
    let current = line;
    if (focused && line.words?.length) {
      const words = line.words.filter(word => word.x + word.width / 2 >= left && word.x + word.width / 2 < right);
      if (!words.length) continue;
      current = bounds(words);
    }
    const text = interfaceImage ? removeWatermark(current.text) : current.text;
    if (!text || (interfaceImage && isInterfaceNoise(text))) continue;
    if (focused && /^(?:复制|[0O过]?制)$/.test(text.replace(/\s/g, '')) && split.some(other => other.x > current.x && Math.abs(other.y - current.y) < current.height && /^(?:输入|输出)[:：．。]/.test(cleanOcrText(other.text)))) continue;
    if (interfaceImage && /^(?:[\p{P}\s]*[S5][R2]\s*\d{5,}|\d{8,}[Ss]?\s*$)/u.test(text)) continue;
    if (interfaceImage && (/^[。．、:：\\一丿乙匕][。．、:：\\一丿乙匕\d\s]*$/.test(text)
      || /^[。．、:：\\一丿乙匕]+\s*\d{6,}/.test(text)
      || /^(?:[.．]\s*)?\d{2}\s*[Ss]{1,2}$|^[Ss][R2][\d\s]*$/.test(text))) continue;
    if (focused && (/^[\p{P}\p{S}\s]+$/u.test(text) || /^\d{1,3}\s*分$/.test(text))) continue;
    clean.push({ ...current, text });
  }
  // Join fragments of the same physical text row, without joining adjacent
  // Input/Output columns that the semantic parser needs to keep separate.
  const ordered = clean.sort((a, b) => a.y - b.y || a.x - b.x);
  const combined: OcrLine[] = [];
  for (const line of ordered) {
    const previous = combined[combined.length - 1];
    if (focused && previous && Math.abs(previous.y + previous.height / 2 - line.y - line.height / 2) < Math.min(previous.height, line.height) * 0.6
      && line.x >= previous.x + previous.width && !(anchorKind(previous.text) && anchorKind(line.text))) {
      const box = bounds([previous, line]);
      combined[combined.length - 1] = { ...box, text: cleanOcrText(previous.text + ' ' + line.text), words: [...(previous.words || [previous]), ...(line.words || [line])] };
    } else combined.push(line);
  }
  const top = Math.max(0, Math.floor((firstTitle?.y ?? combined[0]?.y ?? 0) - 24));
  const bottom = Math.min(image.height, Math.ceil(Math.max(top + 1, ...combined.map(line => line.y + line.height)) + 24));
  const region = focused && !image.focused ? { x: Math.floor(left), y: top, width: Math.ceil(right) - Math.floor(left), height: bottom - top } : undefined;
  return { image: { ...image, lines: combined }, removedLines: Math.max(0, split.length - combined.length), focused, region };
}

export function readableProse(text: string): string {
  const lines = text.split(/\r?\n/).map(cleanOcrText);
  const paragraphs: string[] = [];
  let paragraph = '';
  const flush = () => { if (paragraph) paragraphs.push(paragraph); paragraph = ''; };
  for (const original of lines) {
    const line = original.replace(/\[\s*(\d+(?:\s*[,，]\s*\d+)*)\s*\]/g, (_, numbers: string) => `[${numbers.split(/\s*[,，]\s*/).join(', ')}]`);
    if (!line) { flush(); continue; }
    if (/^(?:[-*•]\s+|\d+[、.．]\s*|时间限制[:：]|内存限制[:：]|(?:arr|[A-Za-z]\w*)\s*=\s*[\[（(])/.test(line)) {
      if (paragraph === line.match(/^([A-Za-z]\w*)\s*=/)?.[1]) paragraph = '';
      flush(); paragraphs.push(line); continue;
    }
    if (paragraph && (/[。！？；:：.!?]$/.test(paragraph) || /^第[一二三四五六七八九十\d]+行|^从(?:左到右|右到左)/.test(line))) flush();
    const separator = paragraph && /[A-Za-z0-9]$/.test(paragraph) && /^[A-Za-z0-9]/.test(line) ? ' ' : '';
    paragraph += separator + line;
  }
  flush();
  return paragraphs.join('\n\n');
}

/** Keep complete numeric descriptions from the unmodified image when contrast
 * enhancement drops digits; sample Input/Output still use the focused pass. */
export function refineRecognitionImage(primary: OcrImage, focused: OcrImage): OcrImage {
  const replacements = prepareRecognitionImage(primary).image.lines.flatMap(line => {
    const inputAt = line.text.search(/输入(?:数字|一个整数|整数)/);
    if (inputAt >= 0 && /\d+\s*(?:<=|≤)\s*\w+\s*(?:<=|≤)\s*\d+/.test(line.text)) return [{ ...line, text: line.text.slice(inputAt), words: undefined }];
    if (/^(?:时间限制|内存限制)[:：]/.test(line.text) || /^arr\s*=\s*\[[\d\s,，]+\]$/.test(line.text)) return [line];
    return [];
  });
  const lines = focused.lines.filter(line => !replacements.some(original => Math.abs(line.y + line.height / 2 - original.y - original.height / 2) < Math.max(line.height, original.height) * 0.65));
  return { ...focused, focused: true, lines: [...lines, ...replacements].sort((a, b) => a.y - b.y || a.x - b.x) };
}
