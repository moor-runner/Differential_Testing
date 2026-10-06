import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { Code2, Copy, Check, Terminal } from 'lucide-react';
import { roleLabels, type CompileError, type Role } from './types';

const detail: Record<Role, string> = { generator: '种子 → 测试数据', brute: '输入 → 标准答案', optimized: '输入 → 待验证答案' };
export function CodeEditor({ role, code, problemId, onChange, diagnostics = [], readOnly = false }: { role: Role; code: string; problemId: string; onChange?: (value: string) => void; diagnostics?: CompileError['diagnostics']; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef({ code, onChange, readOnly });
  latest.current = { code, onChange, readOnly };
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const initial = latest.current;
    const model = monaco.editor.createModel(initial.code, 'java', monaco.Uri.parse(`file:///duipai/${problemId}/${role}/Main.java`));
    const editor = monaco.editor.create(host.current!, {
      model, theme: 'duipai', fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12, lineHeight: 21, minimap: { enabled: false },
      scrollBeyondLastLine: false, automaticLayout: true,
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
    const listener = model.onDidChangeContent(() => latest.current.onChange?.(model.getValue()));
    return () => {
      instance.current = null;
      listener.dispose();
      editor.setModel(null);
      editor.dispose();
      model.dispose();
    };
  }, [problemId, role]);
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
