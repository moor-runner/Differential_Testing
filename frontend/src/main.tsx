import React from 'react';
import ReactDOM from 'react-dom/client';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import 'katex/dist/katex.min.css';
import App from './App';
import { registerJavaLanguage } from './javaLanguage';
import './styles.css';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// Expose the local editor API for desktop integration and diagnostics.
Object.assign(window, { monaco });
const javaLanguage = registerJavaLanguage();
if (import.meta.hot) import.meta.hot.dispose(() => javaLanguage.dispose());
// 纯黑底；语法色只在编辑器内使用，界面其余部分只用琥珀（交互）与红（错误）。
monaco.editor.defineTheme('duipai', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: '', foreground: 'D4D4D4' }, { token: 'comment', foreground: '6A6A6A', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'E8A25C' }, { token: 'string', foreground: 'A5C98A' }, { token: 'number', foreground: 'D4A5E0' },
    { token: 'type.identifier', foreground: 'F2F2F2' }, { token: 'annotation', foreground: '9A9A9A' }, { token: 'delimiter', foreground: '8F8F8F' },
  ],
  colors: {
    'editor.background': '#000000', 'editor.foreground': '#D4D4D4', 'editorGutter.background': '#000000',
    'editorLineNumber.foreground': '#3D3D3D', 'editorLineNumber.activeForeground': '#A0A0A0',
    'editor.lineHighlightBackground': '#0E0E0E', 'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#3A3A3A', 'editor.inactiveSelectionBackground': '#262626', 'editor.selectionHighlightBackground': '#2A2A2A',
    'editor.wordHighlightBackground': '#262626', 'editor.wordHighlightStrongBackground': '#2E2E2E', 'editor.findMatchBackground': '#F2A33A55', 'editor.findMatchHighlightBackground': '#F2A33A26',
    'editorCursor.foreground': '#F2A33A', 'editorBracketMatch.background': '#00000000', 'editorBracketMatch.border': '#6A6A6A',
    'editorIndentGuide.background1': '#161616', 'editorIndentGuide.activeBackground1': '#333333', 'editorWhitespace.foreground': '#2A2A2A',
    'editorWidget.background': '#0D0D0D', 'editorWidget.border': '#2A2A2A', 'editorWidget.foreground': '#D4D4D4',
    'editorSuggestWidget.background': '#0D0D0D', 'editorSuggestWidget.border': '#2A2A2A', 'editorSuggestWidget.selectedBackground': '#262626', 'editorSuggestWidget.highlightForeground': '#F2A33A', 'editorSuggestWidget.focusHighlightForeground': '#F2A33A',
    'editorHoverWidget.background': '#0D0D0D', 'editorHoverWidget.border': '#2A2A2A', 'list.hoverBackground': '#1A1A1A', 'focusBorder': '#00000000',
    'editorError.foreground': '#EF5350', 'editorWarning.foreground': '#F2A33A', 'editorLightBulb.foreground': '#F2A33A',
    'editorStickyScroll.background': '#000000', 'editorStickyScrollHover.background': '#121212', 'editorStickyScroll.shadow': '#00000000', 'editorStickyScroll.border': '#1F1F1F',
    'editorOverviewRuler.errorForeground': '#EF5350', 'editorOverviewRuler.warningForeground': '#F2A33A',
    'scrollbar.shadow': '#00000000', 'scrollbarSlider.background': '#FFFFFF1A', 'scrollbarSlider.hoverBackground': '#FFFFFF2E', 'scrollbarSlider.activeBackground': '#FFFFFF40',
    'diffEditor.insertedTextBackground': '#3FB95026', 'diffEditor.removedTextBackground': '#EF535026', 'diffEditor.insertedLineBackground': '#3FB95014', 'diffEditor.removedLineBackground': '#EF535014',
  },
});
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
