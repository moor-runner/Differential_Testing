import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { Code2, Copy, Check, Terminal } from 'lucide-react';
import { roleLabels, type CompileError, type Role } from './types';

const detail: Record<Role, string> = { generator: '种子 → 测试数据', brute: '输入 → 标准答案', optimized: '输入 → 待验证答案' };
export function CodeEditor({ role, code, problemId, onChange, diagnostics = [], readOnly = false, visible = true, focusRequest = 0, fontSize = 12 }: { role: Role; code: string; problemId: string; onChange?: (value: string) => void; diagnostics?: CompileError['diagnostics']; readOnly?: boolean; visible?: boolean; focusRequest?: number; fontSize?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef({ code, onChange, readOnly, visible, fontSize });
  latest.current = { code, onChange, readOnly, visible, fontSize };
  const hiddenView = useRef<monaco.editor.ICodeEditorViewState | null>(null);
  const [copied, setCopied] = useState(false);
  useLayoutEffect(() => {
    const initial = latest.current;
    const model = monaco.editor.createModel(initial.code, 'java', monaco.Uri.parse(`file:///duipai/${problemId}/${role}/Main.java`));
    const editor = monaco.editor.create(host.current!, {
      model, theme: 'duipai', fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: initial.fontSize, lineHeight: Math.round(initial.fontSize * 1.75), minimap: { enabled: false },
      scrollBeyondLastLine: false, automaticLayout: false,
      padding: { top: 14, bottom: 14 }, tabSize: 4, readOnly: initial.readOnly,
      wordWrap: 'off', renderLineHighlight: 'line', roundedSelection: false,
      lineNumbersMinChars: 3, glyphMargin: false, folding: true,
      bracketPairColorization: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      suggest: { showWords: true },
      scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
      overviewRulerLanes: 0,
    });
    instance.current = editor;
    hiddenView.current = null;
    const resize = new ResizeObserver(() => { if (latest.current.visible && host.current?.clientWidth && host.current?.clientHeight) editor.layout(); });
    resize.observe(host.current!);
    const listener = model.onDidChangeContent(() => latest.current.onChange?.(model.getValue()));
    return () => {
      instance.current = null;
      resize.disconnect();
      listener.dispose();
      editor.setModel(null);
      editor.dispose();
      model.dispose();
    };
  }, [problemId, role]);
  useLayoutEffect(() => {
    const editor = instance.current;
    if (!editor) return;
    const view = editor.saveViewState();
    editor.updateOptions({ fontSize, lineHeight: Math.round(fontSize * 1.75) });
    if (latest.current.visible) editor.layout();
    if (view) editor.restoreViewState(view);
  }, [fontSize, problemId, role]);
  useLayoutEffect(() => {
    const editor = instance.current;
    if (!editor) return;
    if (!visible) { hiddenView.current = editor.saveViewState(); return; }
    const frame = requestAnimationFrame(() => { editor.layout(); if (hiddenView.current) { editor.restoreViewState(hiddenView.current); hiddenView.current = null; } });
    return () => cancelAnimationFrame(frame);
  }, [visible, problemId, role]);
  useEffect(() => {
    if (!focusRequest || !latest.current.visible) return;
    const frame = requestAnimationFrame(() => instance.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  useEffect(() => {
    const editor = instance.current;
    const model = editor?.getModel();
    if (model && model.getValue() !== code) model.setValue(code);
    editor?.updateOptions({ readOnly });
  }, [code, readOnly, problemId, role]);
  useEffect(() => {
    const model = instance.current?.getModel();
    if (model) monaco.editor.setModelMarkers(model, 'javac', diagnostics.filter(d => d.line > 0).map(d => ({ startLineNumber: d.line, endLineNumber: d.line, startColumn: Math.max(1, d.column), endColumn: Math.max(2, d.column + 1), message: d.message, severity: monaco.MarkerSeverity.Error })));
  }, [diagnostics, code, problemId, role]);
  async function copy() { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard may be unavailable outside desktop */ } }
  return <section className={`panel code-panel role-${role}`} aria-label={`${roleLabels[role]} Java 编辑器`}>
    <div className="panel-heading code-heading"><div className="panel-title"><span className="role-icon"><Code2 size={14} /></span><strong>{roleLabels[role]}</strong><span className="file-tag">Main.java</span></div><button className="icon-button" title="复制代码" aria-label={`复制${roleLabels[role]}代码`} onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div>
    <div className="code-context"><Terminal size={11} /><span>{detail[role]}</span><span className="language">JAVA 21</span></div>
    <div className="editor-host" ref={host} />
    <div className="editor-footer"><span>{code.split('\n').length} 行</span>{diagnostics.length ? <span className="error-text">{diagnostics.length} 个编译错误</span> : <span>UTF-8</span>}</div>
  </section>;
}
