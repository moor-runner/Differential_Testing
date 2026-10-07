import test from 'node:test';
import assert from 'node:assert/strict';
import { clampJavaRange, formatJavaIndentation, hasJavaImportConflict, isJavaCodePosition, javaImportEdit, javaInspectOffset, javaMethodSnippet, javaWordBounds, scanJava } from '../src/javaIntelligence.ts';

const format = source => formatJavaIndentation(source, { tabSize: 4, insertSpaces: true });
const applyImport = (source, name) => { const edit = javaImportEdit(source, name); return edit ? source.slice(0, edit.offset) + edit.text + source.slice(edit.offset) : source; };

test('formatter ignores braces in escaped strings, chars, and single-line comments', () => {
  const source = 'class Main {\nvoid test() {\nString value = "{ \\\" }";\nchar c = \'{\'; // }\nSystem.out.println(value);\n}\n}';
  assert.equal(format(source), 'class Main {\n    void test() {\n        String value = "{ \\\" }";\n        char c = \'{\'; // }\n        System.out.println(value);\n    }\n}');
  assert.equal(format(format(source)), format(source));
});

test('formatter preserves every byte inside multiline comments and text blocks', () => {
  const comment = '/* {\n   intentionally indented\n * } */';
  const block = '"""\n  { sample }\n    \\""" not a delimiter\n  """';
  const source = `class Main {\nvoid test() {\n${comment}\nString text = ${block};\nSystem.out.println(text);\n}\n}`;
  const result = format(source);
  assert.ok(result.includes(comment));
  assert.ok(result.includes(block));
  assert.ok(result.includes('\n        System.out.println(text);\n    }\n}'));
  assert.equal(format(result), result);
});

test('formatter preserves mixed EOL, tabs, and trailing spaces inside text blocks', () => {
  const block = '"""\r\n\t first  \n   second\rthird\r\n    """';
  const source = `class Main {\r\nString text = ${block};\n}\r`;
  const result = format(source);
  assert.ok(result.includes(block));
  assert.ok(result.endsWith('\n}\r'));
});

test('continuations and leading closing braces receive bounded indentation', () => {
  const source = 'class Main {\nvoid test() {\ncall(\n1,\n2\n);\nif (true) {\ncall();\n} else {\ncall();\n}\n}\n}';
  assert.equal(format(source), 'class Main {\n    void test() {\n        call(\n            1,\n            2\n        );\n        if (true) {\n            call();\n        } else {\n            call();\n        }\n    }\n}');
  assert.equal(formatJavaIndentation('class Main {\nvoid test() {\n}\n}', { tabSize: 4, insertSpaces: false }), 'class Main {\n\tvoid test() {\n\t}\n}');
});

test('formatter leaves pre-lexical Unicode escapes untouched', () => {
  const source = 'class Main {\n  // \\u000a }\n  int value;\n}';
  assert.equal(format(source), source);
});

test('lexer preserves UTF-16 offsets and blocks completion at unfinished EOF tokens', () => {
  for (const source of ['// sout', '/* sout', 'String s = "sout', "char c = 'x", 'String s = """\n sout']) {
    assert.equal(isJavaCodePosition(source, source.length), false, source);
    assert.equal(scanJava(source).code.length, source.length);
  }
  for (const source of ['/* done */', '"done"', "'x'", '"""\n done\n """']) assert.equal(isJavaCodePosition(source, source.length), true, source);
  const source = '// 😀\r\nint count;';
  assert.equal(scanJava(source).code.indexOf('int'), source.indexOf('int'));
  assert.equal(isJavaCodePosition(source, source.indexOf('\r')), false);
  assert.equal(isJavaCodePosition(source, source.indexOf('int')), true);
});

test('import edits preserve license headers, package statements, and trailing comments', () => {
  const source = '/* license */\r\npackage demo; // same package\r\n\r\nimport java.util.List; // used\r\n\r\nclass Main {}';
  assert.equal(applyImport(source, 'java.util.ArrayList'), '/* license */\r\npackage demo; // same package\r\n\r\nimport java.util.List; // used\r\nimport java.util.ArrayList;\r\n\r\nclass Main {}');
  assert.equal(applyImport('/* header */\nclass Main {}', 'java.util.Scanner'), '/* header */\nimport java.util.Scanner;\n\nclass Main {}');
  assert.equal(applyImport('package demo; class Main {}', 'java.util.Scanner'), 'package demo;\n\nimport java.util.Scanner;\n class Main {}');
});

test('import edits do not duplicate explicit imports, package imports, or java.lang', () => {
  assert.equal(javaImportEdit('import java.util.*;\nclass Main {}', 'java.util.Scanner'), null);
  assert.equal(javaImportEdit('import java.util.Scanner;\nclass Main {}', 'java.util.Scanner'), null);
  assert.equal(javaImportEdit('package java.util;\nclass Main {}', 'java.util.Scanner'), null);
  assert.equal(javaImportEdit('class Main {}', 'java.lang.String'), null);
  assert.equal(javaImportEdit('class Main {}', 'evil;\nclass Other {}'), null);
});

test('import conflict detection respects named declarations and ignores comments and strings', () => {
  assert.equal(hasJavaImportConflict('import demo.List;\nclass Main {}', 'java.util.List'), true);
  assert.equal(javaImportEdit('import demo.List;\nclass Main {}', 'java.util.List'), null);
  assert.equal(hasJavaImportConflict('record List(int size) {}', 'java.util.List'), true);
  assert.equal(hasJavaImportConflict('/* class List {} */\nclass Main { String text = "import demo.List;"; }', 'java.util.List'), false);
  assert.equal(applyImport('// import java.util.Scanner;\nclass Main {}', 'java.util.Scanner'), '// import java.util.Scanner;\nimport java.util.Scanner;\n\nclass Main {}');
});

test('diagnostic bounds remain valid at EOF and for broken compiler ranges', () => {
  assert.deepEqual(clampJavaRange(4, -2, 99), { start: 0, end: 4 });
  assert.deepEqual(clampJavaRange(4, 99, 0), { start: 4, end: 4 });
  assert.deepEqual(clampJavaRange(4, NaN, Infinity), { start: 0, end: 0 });
});

test('completion replaces the complete identifier when caret is in its middle', () => {
  const source = 'class Main { priXYZ void test() {} }';
  const caret = source.indexOf('priXYZ') + 3;
  const word = javaWordBounds(source, caret);
  assert.equal(source.slice(0, word.start) + 'private' + source.slice(word.end), 'class Main { private void test() {} }');
  assert.deepEqual(javaWordBounds('in.nextInt()', 5), { start: 3, end: 10 });
  assert.deepEqual(javaWordBounds('$数据_值', 3), { start: 0, end: 5 });
});

test('definition and hover inspect the symbol when caret is at its right edge', () => {
  const source = 'class Main { void test() { add(1, 2); } }';
  const start = source.indexOf('add'), end = start + 3;
  assert.equal(javaInspectOffset(source, end), end - 1);
  assert.equal(javaInspectOffset(source, start), start);
  assert.equal(javaInspectOffset(source, start + 1), start + 1);
  assert.equal(javaInspectOffset(source, end + 1), end + 1);
  const unicode = 'void 数据𠮷() {}';
  const unicodeEnd = unicode.indexOf('(');
  assert.equal(javaInspectOffset(unicode, unicodeEnd), unicodeEnd - 1);
  assert.deepEqual(javaWordBounds(unicode, unicodeEnd), { start: 5, end: unicodeEnd });
});

test('compiler method insertions handle parameter overloads and Unicode Java names', () => {
  assert.deepEqual(javaMethodSnippet('nextInt()', 'int nextInt()'), { insertText: 'nextInt()$0', hasParameters: false });
  assert.deepEqual(javaMethodSnippet('nextInt(', 'int nextInt(int radix)'), { insertText: 'nextInt(${1})$0', hasParameters: true });
  assert.deepEqual(javaMethodSnippet('累加𠮷(', 'int 累加𠮷(int 值)'), { insertText: '累加𠮷(${1})$0', hasParameters: true });
  assert.deepEqual(javaMethodSnippet('$calc(', 'int $calc(int value)'), { insertText: '\\$calc(${1})$0', hasParameters: true });
  assert.equal(javaMethodSnippet('ArrayList', 'class java.util.ArrayList'), null);
});
