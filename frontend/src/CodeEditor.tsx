import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { AlignLeft, AlertTriangle, Code2, Copy, Check, Keyboard, ListTree, LoaderCircle, Terminal, X } from 'lucide-react';
import { roleLabels, type CompileError, type Role } from './types';
import { attachJavaAnalysis, type JavaEditorAnalysisState } from './javaLanguage';
import { attachJavaEditorActions, javaShortcuts } from './javaEditorActions';

const detail: Record<Role, string> = { generator: '种子 → 测试数据', brute: '输入 → 标准答案', optimized: '输入 → 待验证答案' };
export function CodeEditor({ role, code, problemId, onChange, onDiagnosticsChange, diagnostics = [], readOnly = false, visible = true, focusRequest = 0, fontSize = 12 }: { role: Role; code: string; problemId: string; onChange?: (value: string) => void; onDiagnosticsChange?: (count: number | null) => void; diagnostics?: CompileError['diagnostics']; readOnly?: boolean; visible?: boolean; focusRequest?: number; fontSize?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef({ code, onChange, onDiagnosticsChange, readOnly, visible, fontSize });
  latest.current = { code, onChange, onDiagnosticsChange, readOnly, visible, fontSize };
  const hiddenView = useRef<monaco.editor.ICodeEditorViewState | null>(null);
  const [copied, setCopied] = useState(false);
  const [analysis, setAnalysis] = useState<JavaEditorAnalysisState>({ status: 'checking', diagnostics: [], symbols: [] });
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [popover, setPopover] = useState<'structure' | 'shortcuts' | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [actionError, setActionError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    const initial = latest.current;
    setPopover(null); setShowProblems(false); setActionError(''); setCopied(false);
    setCursor({ lineNumber: 1, column: 1 });
    setAnalysis({ status: 'checking', diagnostics: [], symbols: [] });
    const model = monaco.editor.createModel(initial.code, 'java', monaco.Uri.parse(`file:///duipai/${problemId}/${role}/Main.java`));
    const editor = monaco.editor.create(host.current!, {
      model, theme: 'duipai', fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: initial.fontSize, lineHeight: Math.round(initial.fontSize * 1.75), minimap: { enabled: false },
      scrollBeyondLastLine: false, automaticLayout: false,
      padding: { top: 14, bottom: 14 }, tabSize: 4, readOnly: initial.readOnly,
      wordWrap: 'off', renderLineHighlight: 'all', roundedSelection: true,
      lineNumbersMinChars: 3, glyphMargin: true, folding: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, highlightActiveBracketPair: true, indentation: true },
      autoIndent: 'full', autoClosingBrackets: 'languageDefined', autoClosingQuotes: 'languageDefined',
      autoSurround: 'languageDefined', tabCompletion: 'onlySnippets', snippetSuggestions: 'top',
      suggestSelection: 'recentlyUsedByPrefix', suggestOnTriggerCharacters: true,
      quickSuggestionsDelay: 150, parameterHints: { enabled: true, cycle: true },
      stickyScroll: { enabled: true, maxLineCount: 3 },
      renderWhitespace: 'selection', occurrencesHighlight: 'singleFile',
      cursorSmoothCaretAnimation: 'explicit', smoothScrolling: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggest: { showWords: false, preview: true, showStatusBar: true },
      scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
      overviewRulerLanes: 2, hideCursorInOverviewRuler: true,
      fixedOverflowWidgets: true,
    });
    instance.current = editor;
    hiddenView.current = null;
    const resize = new ResizeObserver(() => { if (latest.current.visible && host.current?.clientWidth && host.current?.clientHeight) editor.layout(); });
    resize.observe(host.current!);
    const listener = model.onDidChangeContent(() => latest.current.onChange?.(model.getValue()));
    const intelligence = attachJavaAnalysis(editor, state => {
      setAnalysis(state);
      latest.current.onDiagnosticsChange?.(state.status === 'ready' ? state.diagnostics.filter(d => d.severity === 'error').length : null);
    });
    const actions = attachJavaEditorActions(editor, () => setPopover(value => value === 'structure' ? null : 'structure'));
    const cursorListener = editor.onDidChangeCursorPosition(event => setCursor(event.position));
    return () => {
      instance.current = null;
      resize.disconnect();
      listener.dispose();
      intelligence.dispose(); actions.dispose(); cursorListener.dispose();
      clearTimeout(copyTimer.current);
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
  useEffect(() => {
    if (!visible) { setPopover(null); return; }
    if (!popover) return;
    const closeOutside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) setPopover(null); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [popover, visible]);
  const errors = analysis.diagnostics.filter(d => d.severity === 'error');
  const warnings = analysis.diagnostics.filter(d => d.severity === 'warning');
  const problemCount = analysis.status === 'ready' ? errors.length + warnings.length : diagnostics.length;
  async function runAction(id: string) {
    const editor = instance.current;
    if (!editor) return;
    setActionError(''); editor.focus();
    try { await editor.getAction(id)?.run(); } catch { setActionError('编辑操作未完成，请重试。'); }
  }
  function goToOffset(start: number, end = start) {
    const editor = instance.current, model = editor?.getModel();
    if (!editor || !model) return;
    const from = model.getPositionAt(start), to = model.getPositionAt(end);
    editor.setSelection(new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column));
    editor.revealPositionInCenterIfOutsideViewport(from); editor.focus(); setPopover(null);
  }
  async function copy() { try { await navigator.clipboard.writeText(code); setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1600); } catch { setActionError('复制失败，请使用 Ctrl+C。'); } }
  return <section ref={panel} className={`panel code-panel role-${role}`} aria-label={`${roleLabels[role]} Java 编辑器`} onKeyDown={event => {
    if (event.key === 'Escape' && popover) { event.stopPropagation(); setPopover(null); instance.current?.focus(); }
  }}>
    <div className="panel-heading code-heading"><div className="panel-title"><span className="role-icon"><Code2 size={14} /></span><strong>{roleLabels[role]}</strong><span className="file-tag">Main.java</span></div><div className="code-heading-actions">
      <button className="icon-button" disabled={readOnly} title="整理代码缩进（Ctrl+Alt+L）" aria-label={`格式化${roleLabels[role]}代码`} onClick={() => { void runAction('duipai.java.format'); }}><AlignLeft size={14} /></button>
      <button className="icon-button" title="文件结构（Ctrl+F12）" aria-label={`${roleLabels[role]}文件结构`} aria-expanded={popover === 'structure'} onClick={() => setPopover(value => value === 'structure' ? null : 'structure')}><ListTree size={14} /></button>
      <button className="icon-button" title="IDEA 风格快捷键" aria-label={`${roleLabels[role]}编辑器快捷键`} aria-expanded={popover === 'shortcuts'} onClick={() => setPopover(value => value === 'shortcuts' ? null : 'shortcuts')}><Keyboard size={14} /></button>
      <button className="icon-button" title="复制代码" aria-label={`复制${roleLabels[role]}代码`} onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    </div></div>
    <div className="code-context"><Terminal size={11} /><span>{detail[role]}</span><span className="language">JAVA 21</span></div>
    <div className="editor-host" ref={host} />
    {popover && <div className={`java-popover ${popover === 'structure' ? 'java-outline' : 'java-shortcuts'}`} role="region" aria-label={popover === 'structure' ? `${roleLabels[role]}文件结构列表` : 'Java 编辑器快捷键列表'}>
      <div className="java-popover-heading"><strong>{popover === 'structure' ? 'Main.java · 文件结构' : 'IDEA 风格快捷键'}</strong><button className="icon-button" aria-label="关闭编辑器工具" onClick={() => { setPopover(null); instance.current?.focus(); }}><X size={13} /></button></div>
      {popover === 'structure' ? <div className="java-symbols">{analysis.symbols.length ? analysis.symbols.map((symbol, index) => <button key={`${symbol.start}-${index}`} title={symbol.detail} onClick={() => goToOffset(symbol.selectionStart, symbol.selectionEnd)}><span className={`java-symbol-kind kind-${symbol.kind}`}>{['class', 'interface', 'enum'].includes(symbol.kind) ? 'C' : symbol.kind === 'field' ? 'F' : 'M'}</span><span>{symbol.name}<small>{symbol.detail}</small></span></button>) : <p className="java-tool-empty">{analysis.status === 'checking' ? '正在分析文件结构…' : '暂无可显示的类或方法。'}</p>}</div> : <><dl>{javaShortcuts.map(([key, description]) => <div key={key}><dt>{description}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl><p className="java-tool-note">模板：psvm / main、sout、soutv、fori、iter、fastio。输入后选择补全项，Tab 切换占位符。</p></>}
    </div>}
    {showProblems && problemCount > 0 && <div className="java-problems" aria-label={`${roleLabels[role]}代码问题`}>
      {analysis.status === 'ready' ? analysis.diagnostics.filter(d => d.severity !== 'info').slice(0, 100).map((diagnostic, index) => <button className={diagnostic.severity === 'error' ? 'error-text' : 'warning-text'} key={index} title={diagnostic.message} onClick={() => goToOffset(diagnostic.start, diagnostic.end)}><AlertTriangle size={12} /><span>{diagnostic.message}</span></button>) : diagnostics.map((diagnostic, index) => <button className="error-text" key={index} onClick={() => { const editor = instance.current; editor?.setPosition({ lineNumber: Math.max(1, diagnostic.line), column: Math.max(1, diagnostic.column) }); editor?.revealLineInCenterIfOutsideViewport(Math.max(1, diagnostic.line)); editor?.focus(); }}><AlertTriangle size={12} /><span>{diagnostic.message}</span></button>)}
    </div>}
    <div className="editor-footer"><span title={`${code.split('\n').length} 行 · UTF-8 · 4 空格`}>行 {cursor.lineNumber} : 列 {cursor.column}</span><button className={`java-check-state ${problemCount ? analysis.status !== 'ready' || errors.length ? 'error-text' : 'warning-text' : ''}`} title={actionError || (analysis.status === 'unavailable' ? '本地 Java 分析暂不可用；继续输入会重试。' : '即时编译检查；F2 跳转到下一个问题。')} aria-expanded={showProblems} onClick={() => setShowProblems(value => !value)}>
      {analysis.status === 'checking' ? <><LoaderCircle size={10} className="spin" />检查中…</> : problemCount ? <><AlertTriangle size={10} />{analysis.status === 'ready' ? errors.length ? `${errors.length} 个编译错误${warnings.length ? ` · ${warnings.length} 个警告` : ''}` : `${warnings.length} 个警告` : `${diagnostics.length} 个编译错误`}</> : analysis.status === 'unavailable' ? 'Java 服务不可用' : <><Check size={10} />Java 检查通过</>}
    </button></div>
    {actionError && <div className="java-action-error" role="status">{actionError}<button className="icon-button" aria-label="关闭编辑操作提示" onClick={() => setActionError('')}><X size={12} /></button></div>}
  </section>;
}
