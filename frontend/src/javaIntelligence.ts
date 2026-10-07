/** Java editor protocol. All source positions are zero-based UTF-16 offsets. */
export interface JavaDiagnostic { start: number; end: number; severity: 'error' | 'warning' | 'info'; message: string; code: string }
export interface JavaSymbol { name: string; kind: 'class' | 'interface' | 'enum' | 'method' | 'constructor' | 'field'; detail: string; start: number; end: number; selectionStart: number; selectionEnd: number }
export interface JavaCompletion { label: string; kind: 'method' | 'field' | 'variable' | 'class' | 'keyword'; detail: string; insertText: string; importName?: string }
export interface JavaAnalysis {
  diagnostics: JavaDiagnostic[]; symbols: JavaSymbol[]; completions: JavaCompletion[];
  hover: { start: number; end: number; contents: string } | null;
  definition: { start: number; end: number } | null;
  signatures: { label: string; parameters: string[] }[]; activeParameter: number;
}
export type JavaOperation = 'analyze' | 'complete' | 'inspect' | 'signature';
export interface JavaEditorAnalysisState { status: 'checking' | 'ready' | 'unavailable'; diagnostics: JavaDiagnostic[]; symbols: JavaSymbol[] }

export const JAVA_KEYWORDS = ['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'null', 'package', 'private', 'protected', 'public', 'record', 'return', 'sealed', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'var', 'void', 'volatile', 'while', 'yield', 'true', 'false'];

/** Common Java 21 library types. Compiler results supply the actual members. */
export const JAVA_IMPORTS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...['Scanner', 'Arrays', 'Collections', 'Comparator', 'Objects', 'Random', 'SplittableRandom', 'List', 'ArrayList', 'LinkedList', 'Map', 'HashMap', 'TreeMap', 'LinkedHashMap', 'Set', 'HashSet', 'TreeSet', 'LinkedHashSet', 'Queue', 'Deque', 'ArrayDeque', 'PriorityQueue', 'Iterator', 'StringTokenizer', 'BitSet', 'Optional', 'OptionalInt', 'OptionalLong', 'IntSummaryStatistics'].map(name => [name, `java.util.${name}`]),
  ...['BufferedReader', 'BufferedWriter', 'InputStreamReader', 'OutputStreamWriter', 'PrintWriter', 'InputStream', 'OutputStream', 'IOException', 'File', 'FileInputStream', 'FileOutputStream', 'ByteArrayInputStream', 'ByteArrayOutputStream'].map(name => [name, `java.io.${name}`]),
  ...['BigInteger', 'BigDecimal', 'MathContext', 'RoundingMode'].map(name => [name, `java.math.${name}`]),
  ...['IntStream', 'LongStream', 'DoubleStream', 'Stream', 'Collectors'].map(name => [name, `java.util.stream.${name}`]),
  ...['Path', 'Paths', 'Files'].map(name => [name, `java.nio.file.${name}`]),
  ...['Pattern', 'Matcher'].map(name => [name, `java.util.regex.${name}`]),
  ...['String', 'StringBuilder', 'StringBuffer', 'Math', 'System', 'Integer', 'Long', 'Double', 'Character', 'Boolean', 'Object', 'Exception', 'RuntimeException', 'Thread', 'Comparable', 'Iterable'].map(name => [name, `java.lang.${name}`]),
]));

export interface JavaTemplate { label: string; detail: string; insertText: string }
export const JAVA_TEMPLATES: readonly JavaTemplate[] = [
  ...['main', 'psvm'].map(label => ({ label, detail: 'main 方法 · IDEA Live Template', insertText: 'public static void main(String[] args) throws Exception {\n\t$0\n}' })),
  { label: 'sout', detail: '输出一行 · System.out.println', insertText: 'System.out.println(${1});$0' },
  { label: 'soutv', detail: '输出变量名称和值', insertText: 'System.out.println("${1:value} = " + $1);$0' },
  { label: 'serr', detail: '标准错误输出', insertText: 'System.err.println(${1});$0' },
  { label: 'fori', detail: '索引 for 循环', insertText: 'for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}' },
  { label: 'iter', detail: '增强 for 循环', insertText: 'for (${1:var} ${2:item} : ${3:collection}) {\n\t$0\n}' },
  { label: 'while', detail: 'while 循环', insertText: 'while (${1:condition}) {\n\t$0\n}' },
  { label: 'if', detail: 'if 条件块', insertText: 'if (${1:condition}) {\n\t$0\n}' },
  { label: 'try', detail: 'try / catch', insertText: 'try {\n\t${1}\n} catch (${2:Exception} ${3:e}) {\n\t$0\n}' },
  { label: 'fastio', detail: '竞赛快读 · 在类中插入 FastScanner（支持 long / int）', insertText: 'static final class FastScanner {\n\tprivate final java.io.InputStream in = System.in;\n\tprivate final byte[] buffer = new byte[1 << 16];\n\tprivate int pointer, length;\n\tprivate int read() throws java.io.IOException {\n\t\tif (pointer >= length) {\n\t\t\tlength = in.read(buffer);\n\t\t\tpointer = 0;\n\t\t\tif (length <= 0) return -1;\n\t\t}\n\t\treturn buffer[pointer++] & 255;\n\t}\n\tString next() throws java.io.IOException {\n\t\tStringBuilder value = new StringBuilder();\n\t\tint c;\n\t\tdo { c = read(); } while (c >= 0 && c <= 32);\n\t\tif (c < 0) return null;\n\t\twhile (c > 32) { value.append((char) c); c = read(); }\n\t\treturn value.toString();\n\t}\n\tlong nextLong() throws java.io.IOException {\n\t\tString value = next();\n\t\tif (value == null) throw new java.io.EOFException();\n\t\treturn Long.parseLong(value);\n\t}\n\tint nextInt() throws java.io.IOException { return Math.toIntExact(nextLong()); }\n}\n$0' },
];

type LexicalKind = 'comment' | 'string' | 'character' | 'textBlock';
interface LexicalRange { start: number; end: number; kind: LexicalKind; unterminated: boolean }
export interface JavaLexicalView { code: string; protectedRanges: LexicalRange[] }

/** Replace non-code with spaces while preserving every offset and newline. */
export function scanJava(source: string): JavaLexicalView {
  const chars = source.split('');
  const protectedRanges: LexicalRange[] = [];
  let i = 0;
  const blank = (start: number, end: number, kind: LexicalKind, unterminated = false) => {
    protectedRanges.push({ start, end, kind, unterminated });
    for (let j = start; j < end; j++) if (chars[j] !== '\n' && chars[j] !== '\r') chars[j] = ' ';
  };
  while (i < source.length) {
    const start = i;
    if (source.startsWith('//', i)) {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      blank(start, i, 'comment', true); // The cursor immediately before the newline is still inside a line comment.
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2;
      blank(start, i, 'comment', end < 0);
    } else if (source.startsWith('"""', i)) {
      i += 3;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i = Math.min(source.length, i + 2); continue; }
        if (source.startsWith('"""', i)) { i += 3; closed = true; break; }
        i++;
      }
      blank(start, i, 'textBlock', !closed);
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i++];
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\n' || source[i] === '\r') break; // Incomplete ordinary strings cannot consume the next code line.
        if (source[i] === '\\') { i = Math.min(source.length, i + 2); continue; }
        if (source[i++] === quote) { closed = true; break; }
      }
      blank(start, i, quote === '"' ? 'string' : 'character', !closed);
    } else i++;
  }
  return { code: chars.join(''), protectedRanges };
}

export function isJavaCodePosition(source: string, offset: number): boolean {
  return !scanJava(source).protectedRanges.some(range => range.start < offset && (offset < range.end || (range.unterminated && offset === range.end)));
}

/** Indentation only: never rewrite Java tokens, comments, or text-block contents. */
export function formatJavaIndentation(source: string, options: { tabSize: number; insertSpaces: boolean }): string {
  // Unicode escapes are expanded before Java lexing and can create delimiters.
  if (/\\u+[0-9a-fA-F]{4}/.test(source)) return source;
  const lexical = scanJava(source);
  // Retain each newline individually, including mixed EOL inside text blocks.
  const parts = source.split(/(\r\n|\n|\r)/), codeParts = lexical.code.split(/(\r\n|\n|\r)/);
  const unit = options.insertSpaces ? ' '.repeat(Math.max(1, Math.min(16, options.tabSize))) : '\t';
  let braces = 0, parentheses = 0, brackets = 0, offset = 0;
  let output = '';
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index], eol = parts[index + 1] || '', code = codeParts[index];
    const leadingClosers = code.match(/^\s*(}+)/)?.[1].length || 0;
    const protectedLine = lexical.protectedRanges.some(range => range.start < offset && offset < range.end);
    const isCase = /^\s*(?:case\b.*:|default\s*:)/.test(code);
    const closesContinuation = /^\s*[)\]]/.test(code);
    const continuation = (parentheses > 0 || brackets > 0) && !closesContinuation ? 1 : 0;
    const level = Math.max(0, braces - leadingClosers - (isCase ? 1 : 0) + continuation);
    const result = protectedLine || !line.trim() ? line : unit.repeat(level) + line.replace(/^[ \t]*/, '');
    for (const char of code) {
      if (char === '{') braces++;
      else if (char === '}') braces = Math.max(0, braces - 1);
      else if (char === '(') parentheses++;
      else if (char === ')') parentheses = Math.max(0, parentheses - 1);
      else if (char === '[') brackets++;
      else if (char === ']') brackets = Math.max(0, brackets - 1);
    }
    offset += line.length + eol.length;
    output += result + eol;
  }
  return output;
}

export interface JavaImportEdit { offset: number; text: string }
interface ImportStatement { name: string; static: boolean; start: number; end: number }
function importStatements(code: string): ImportStatement[] {
  return Array.from(code.matchAll(/\bimport\s+(?:(static)\s+)?([\w$]+(?:\.[\w$]+)*(?:\.\*)?)\s*;/g), match => ({ name: match[2], static: !!match[1], start: match.index!, end: match.index! + match[0].length }));
}

export function hasJavaImportConflict(source: string, importName: string): boolean {
  const simple = importName.slice(importName.lastIndexOf('.') + 1);
  const code = scanJava(source).code;
  return importStatements(code).some(item => !item.static && item.name !== importName && item.name.endsWith(`.${simple}`))
    || new RegExp(`\\b(?:class|interface|enum|record)\\s+${simple}\\b`).test(code);
}

/** Insert after package/imports, preserving header comments and existing imports. */
export function javaImportEdit(source: string, importName: string): JavaImportEdit | null {
  if (!/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+$/.test(importName) || importName.startsWith('java.lang.') || hasJavaImportConflict(source, importName)) return null;
  const code = scanJava(source).code;
  const statements = importStatements(code);
  const packageName = code.match(/\bpackage\s+([\w$.]+)\s*;/);
  const namespace = importName.slice(0, importName.lastIndexOf('.'));
  if (packageName?.[1] === namespace || statements.some(item => !item.static && (item.name === importName || item.name === `${namespace}.*`))) return null;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const last = statements.at(-1);
  const afterStatement = (end: number, prefix: string): JavaImportEdit => {
    const nextNewline = source.indexOf('\n', end);
    const lineEnd = nextNewline < 0 ? source.length : nextNewline;
    // Do not separate an existing trailing comment from its import/package.
    if (!code.slice(end, lineEnd).trim()) {
      const offset = nextNewline < 0 ? source.length : nextNewline + 1;
      return { offset, text: `${nextNewline < 0 ? eol : ''}${prefix}import ${importName};${eol}` };
    }
    return { offset: end, text: `${eol}${prefix}import ${importName};${eol}` };
  };
  if (last) return afterStatement(last.end, '');
  if (packageName) return afterStatement(packageName.index! + packageName[0].length, eol);
  const firstCode = code.search(/\S/);
  if (firstCode < 0) return { offset: source.length, text: `${source && !source.endsWith('\n') ? eol : ''}import ${importName};${eol}${eol}` };
  const lineStart = source.lastIndexOf('\n', firstCode - 1) + 1;
  const offset = source.slice(lineStart, firstCode).trim() ? firstCode : lineStart;
  return { offset, text: `${offset > 0 && !source.slice(0, offset).endsWith('\n') ? eol : ''}import ${importName};${eol}${eol}` };
}

/** Diagnostic positions from incomplete syntax must still be valid Monaco ranges. */
export function clampJavaRange(length: number, start: number, end: number): { start: number; end: number } {
  const from = Math.max(0, Math.min(length, Number.isFinite(start) ? Math.trunc(start) : 0));
  return { start: from, end: Math.max(from, Math.min(length, Number.isFinite(end) ? Math.trunc(end) : from)) };
}

/** Full identifier replacement, including the suffix to the right of the caret. */
export function javaWordBounds(source: string, offset: number): { start: number; end: number } {
  const identifierPart = /^[\p{L}\p{N}\p{M}\p{Pc}\p{Sc}$]$/u;
  let start = Math.max(0, Math.min(source.length, offset)), end = start;
  while (start > 0) {
    const previous = start >= 2 && source.charCodeAt(start - 1) >= 0xdc00 && source.charCodeAt(start - 1) <= 0xdfff && source.charCodeAt(start - 2) >= 0xd800 && source.charCodeAt(start - 2) <= 0xdbff ? start - 2 : start - 1;
    if (!identifierPart.test(source.slice(previous, start))) break;
    start = previous;
  }
  while (end < source.length) {
    const point = String.fromCodePoint(source.codePointAt(end)!);
    if (!identifierPart.test(point)) break;
    end += point.length;
  }
  return { start, end };
}

/** javac reference ranges exclude the right edge; Ctrl+B commonly starts there. */
export function javaInspectOffset(source: string, offset: number): number {
  const bounded = Math.max(0, Math.min(source.length, offset));
  const word = javaWordBounds(source, bounded);
  return word.start < bounded && word.end === bounded ? bounded - 1 : bounded;
}

/** Turn compiler call insertions into Monaco snippets with a useful caret. */
export function javaMethodSnippet(insertText: string, detail: string): { insertText: string; hasParameters: boolean } | null {
  if (!/^[\p{L}\p{N}\p{M}\p{Pc}\p{Sc}$]+\(\)?$/u.test(insertText)) return null;
  const name = insertText.slice(0, insertText.indexOf('(')).replace(/\$/g, '\\$');
  const hasParameters = insertText.endsWith('(') || !!detail.match(/\(([^)]*)\)/)?.[1].trim();
  return { insertText: hasParameters ? `${name}(\${1})$0` : `${name}()$0`, hasParameters };
}
