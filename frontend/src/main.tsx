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
monaco.editor.defineTheme('duipai', {
  base: 'vs-dark', inherit: true,
  rules: [{ token: 'comment', foreground: '62758B', fontStyle: 'italic' }, { token: 'keyword', foreground: 'C4A2F6' }, { token: 'string', foreground: '9CCFA8' }, { token: 'number', foreground: 'F3BB83' }, { token: 'type.identifier', foreground: '81CED4' }],
  colors: { 'editor.background': '#121B27', 'editor.foreground': '#CED9E5', 'editorLineNumber.foreground': '#45576A', 'editorLineNumber.activeForeground': '#9AAEC3', 'editor.lineHighlightBackground': '#192434', 'editor.selectionBackground': '#2D4D64', 'editorCursor.foreground': '#63D7C0', 'editorIndentGuide.background1': '#243040', 'editorIndentGuide.activeBackground1': '#4A617B', 'editorWidget.background': '#182434', 'editorWidget.border': '#35475C', 'editorSuggestWidget.background': '#182434', 'editorSuggestWidget.border': '#35475C', 'editorSuggestWidget.selectedBackground': '#2D4D64', 'editorHoverWidget.background': '#182434', 'editorHoverWidget.border': '#35475C', 'editorError.foreground': '#ED939E', 'editorWarning.foreground': '#E1BC77', 'editorLightBulb.foreground': '#E1BC77', 'editorStickyScroll.background': '#141E2B', 'editorOverviewRuler.errorForeground': '#ED939E', 'editorOverviewRuler.warningForeground': '#E1BC77', 'scrollbarSlider.background': '#566E8738', 'scrollbarSlider.hoverBackground': '#566E8766' },
});
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
