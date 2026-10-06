import React from 'react';
import ReactDOM from 'react-dom/client';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import 'katex/dist/katex.min.css';
import App from './App';
import './styles.css';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// Expose the local editor API for desktop integration and diagnostics.
Object.assign(window, { monaco });
monaco.languages.registerCompletionItemProvider('java', {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    const keywords = ['public', 'private', 'protected', 'static', 'final', 'class', 'void', 'int', 'long', 'double', 'boolean', 'String', 'return', 'if', 'else', 'for', 'while', 'break', 'continue', 'new', 'import', 'throws', 'try', 'catch'];
    return { suggestions: [
      ...keywords.map(label => ({ label, kind: monaco.languages.CompletionItemKind.Keyword, insertText: label, range })),
      { label: 'main', kind: monaco.languages.CompletionItemKind.Snippet, detail: 'Java main 方法', insertText: 'public static void main(String[] args) throws Exception {\n\t${1}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range },
      { label: 'sout', kind: monaco.languages.CompletionItemKind.Snippet, detail: '标准输出', insertText: 'System.out.println(${1});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range },
      { label: 'Scanner', kind: monaco.languages.CompletionItemKind.Snippet, detail: '从标准输入读取', insertText: 'Scanner ${1:in} = new Scanner(System.in);', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range },
    ] };
  },
});
monaco.editor.defineTheme('duipai', {
  base: 'vs-dark', inherit: true,
  rules: [{ token: 'comment', foreground: '62758B', fontStyle: 'italic' }, { token: 'keyword', foreground: 'C4A2F6' }, { token: 'string', foreground: '9CCFA8' }, { token: 'number', foreground: 'F3BB83' }, { token: 'type.identifier', foreground: '81CED4' }],
  colors: { 'editor.background': '#121B27', 'editor.foreground': '#CED9E5', 'editorLineNumber.foreground': '#45576A', 'editorLineNumber.activeForeground': '#9AAEC3', 'editor.lineHighlightBackground': '#192434', 'editor.selectionBackground': '#2D4D64', 'editorCursor.foreground': '#63D7C0', 'editorIndentGuide.background1': '#243040', 'editorWidget.background': '#182434', 'editorSuggestWidget.background': '#182434', 'editorSuggestWidget.border': '#35475C', 'scrollbarSlider.background': '#566E8738', 'scrollbarSlider.hoverBackground': '#566E8766' },
});
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
