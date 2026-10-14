import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { AlignLeft, AlertTriangle, Copy, Check, Keyboard, ListTree, X } from 'lucide-react';
import { roleDetails, roleLabels, type CompileError, type Role } from './types';
import { attachJavaAnalysis, type JavaEditorAnalysisState } from './javaLanguage';
import { attachJavaEditorActions, javaShortcuts } from './javaEditorActions';
import { attachDebugEditor, type DebugEditorCallbacks, type DebugEditorHandle, type DebugHoverScope } from './debugEditor';
import type { InlineValue } from './debugModel';

export const codeFont = "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace";
const lineHeight = (fontSize: number) => Math.round(fontSize * 1.6);
/** One shared empty list, so an editor without run-time errors does not rewrite its markers on every render. */
export const noDiagnostics: CompileError['diagnostics'] = [];
const lockedMessage = { value: '调试中不能修改这份代码。按 Ctrl+F2 或点击「停止」结束调试后再编辑。' };

/** Breakpoints of a debuggable program and, while it is being debugged, where it is paused. */
export interface EditorDebug extends DebugEditorCallbacks {
  breakpoints: readonly number[];
  /** Whether each breakpoint is bound to code; only known during a session. */
  verified: ReadonlyMap<number, boolean> | null;
  currentLine: number | null;
  frameLine: number | null;
  inline: readonly InlineValue[];
  hover: (() => DebugHoverScope | null) | null;
  paused: boolean;
  /** Read-only while its own session runs: the program executes the code as it was when debugging started. */
  locked: boolean;
  /** Changes when the editor should bring the execution line into view. */
  revealKey: string;
  toolbar?: ReactNode;
}

export function CodeEditor({ role, code, problemId, onChange, onDiagnosticsChange, diagnostics = noDiagnostics, readOnly = false, visible = true, focusRequest = 0, fontSize = 14, compact = false, immersive = false, debug }: { role: Role; code: string; problemId: string; onChange?: (value: string) => void; onDiagnosticsChange?: (count: number | null) => void; diagnostics?: CompileError['diagnostics']; readOnly?: boolean; visible?: boolean; focusRequest?: number; fontSize?: number; compact?: boolean; immersive?: boolean; debug?: EditorDebug }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const locked = readOnly || !!debug?.locked;
  const latest = useRef({ code, onChange, onDiagnosticsChange, readOnly: locked, visible, fontSize, debuggable: !!debug });
  latest.current = { code, onChange, onDiagnosticsChange, readOnly: locked, visible, fontSize, debuggable: !!debug };
  const debugHandle = useRef<DebugEditorHandle | null>(null);
  const debugCallbacks = useRef<DebugEditorCallbacks>({ toggle() {}, moved() {}, runToLine() {} });
  if (debug) debugCallbacks.current = { toggle: debug.toggle, moved: debug.moved, runToLine: debug.runToLine };
  const hiddenView = useRef<monaco.editor.ICodeEditorViewState | null>(null);
  const [copied, setCopied] = useState(false);
  const [analysis, setAnalysis] = useState<JavaEditorAnalysisState>({ status: 'checking', diagnostics: [], symbols: [] });
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [popover, setPopover] = useState<'structure' | 'shortcuts' | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [actionError, setActionError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const slideUntil = useRef(0);
  useLayoutEffect(() => {
    const initial = latest.current;
    setPopover(null); setShowProblems(false); setActionError(''); setCopied(false);
    setCursor({ lineNumber: 1, column: 1 });
    setAnalysis({ status: 'checking', diagnostics: [], symbols: [] });
    const model = monaco.editor.createModel(initial.code, 'java', monaco.Uri.parse(`file:///duipai/${problemId}/${role}/Main.java`));
    // Standalone Monaco reads bracket colors from the model, not the editor option.
    model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
    const editor = monaco.editor.create(host.current!, {
      model, theme: 'duipai', fontFamily: codeFont,
      fontSize: initial.fontSize, lineHeight: lineHeight(initial.fontSize), minimap: { enabled: false },
      scrollBeyondLastLine: false, automaticLayout: false,
      padding: { top: 12, bottom: 12 }, tabSize: 4, readOnly: initial.readOnly, readOnlyMessage: lockedMessage,
      wordWrap: 'off', renderLineHighlight: 'line', roundedSelection: false,
      // The glyph margin holds breakpoints and the execution arrow of the programs that can be debugged.
      lineNumbersMinChars: 3, glyphMargin: initial.debuggable, folding: true, showFoldingControls: 'mouseover',
      bracketPairColorization: { enabled: false }, matchBrackets: 'always',
      guides: { bracketPairs: false, highlightActiveBracketPair: false, indentation: true, highlightActiveIndentation: true },
      cursorBlinking: 'smooth', overviewRulerBorder: false,
      autoIndent: 'full', autoClosingBrackets: 'languageDefined', autoClosingQuotes: 'languageDefined',
      autoSurround: 'languageDefined', tabCompletion: 'onlySnippets', snippetSuggestions: 'top',
      suggestSelection: 'recentlyUsedByPrefix', suggestOnTriggerCharacters: true,
      quickSuggestionsDelay: 150, parameterHints: { enabled: true, cycle: true },
      stickyScroll: { enabled: true, maxLineCount: 3 },
      renderWhitespace: 'selection', occurrencesHighlight: 'singleFile',
      // A gliding caret trails every arrow-key press by ~80 ms; IDEA and VS Code move it at once. Smooth scrolling
      // likewise animates every reveal that typing causes (Enter on the last visible line, a long line), so the text trails the caret.
      cursorSmoothCaretAnimation: 'off', smoothScrolling: false,
      quickSuggestions: { other: true, comments: false, strings: false },
      // Monaco documents this as off by default but, left unset, validates it to `filterGraceful`'s `true`: after Tab
      // accepts a method or template, nothing would pop up while typing its arguments until the snippet ends.
      suggest: { showWords: false, preview: true, showStatusBar: true, snippetsPreventQuickSuggestions: false },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
      overviewRulerLanes: 2, hideCursorInOverviewRuler: true,
      fixedOverflowWidgets: true,
    });
    instance.current = editor;
    hiddenView.current = null;
    // 沉浸编辑收起或展开边栏时编辑器顶边随之移动：同步滚动让正文停在原处；已滚到顶无法抵消的部分记入 drift，展开时先补回。
    let anchor: number | null = null, drift = 0;
    const resize = new ResizeObserver(() => {
      const element = host.current;
      if (!latest.current.visible || !element?.clientWidth || !element.clientHeight) { anchor = null; return; }
      const top = element.getBoundingClientRect().top, shift = anchor === null || performance.now() > slideUntil.current ? 0 : top - anchor;
      anchor = top;
      const before = editor.getScrollTop(); // 变高时 layout 会先把滚动位置夹到新的上限，偏移以此前的位置为准
      editor.layout();
      if (shift) {
        editor.setScrollTop(before + shift + drift, monaco.editor.ScrollType.Immediate);
        drift += shift - (editor.getScrollTop() - before);
      }
      // Monaco 把重绘排到下一帧：这一帧编辑器已随边栏移动，正文却仍按旧滚动位置绘制，会先跟着跳约 20px 再逐帧回位。当场重绘，让补偿与移动落在同一帧。
      editor.render();
    });
    resize.observe(host.current!);
    const listener = model.onDidChangeContent(() => latest.current.onChange?.(model.getValue()));
    const intelligence = attachJavaAnalysis(editor, state => {
      setAnalysis(state);
      latest.current.onDiagnosticsChange?.(state.status === 'ready' ? state.diagnostics.filter(d => d.severity === 'error').length : null);
    });
    const actions = attachJavaEditorActions(editor, () => setPopover(value => value === 'structure' ? null : 'structure'));
    const cursorListener = editor.onDidChangeCursorPosition(event => setCursor(event.position));
    debugHandle.current = initial.debuggable ? attachDebugEditor(editor, debugCallbacks) : null;
    return () => {
      instance.current = null;
      resize.disconnect();
      listener.dispose();
      debugHandle.current?.dispose(); debugHandle.current = null;
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
    editor.updateOptions({ fontSize, lineHeight: lineHeight(fontSize) });
    if (latest.current.visible) editor.layout();
    if (view) editor.restoreViewState(view);
  }, [fontSize, problemId, role]);
  useLayoutEffect(() => { slideUntil.current = performance.now() + 450; }, [immersive]);
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
    editor?.updateOptions({ readOnly: locked });
  }, [code, locked, problemId, role]);
  const { breakpoints, verified, currentLine, frameLine, inline, hover, paused, revealKey } = debug ?? {};
  useEffect(() => { if (breakpoints) debugHandle.current?.setBreakpoints(breakpoints, verified ?? null); }, [breakpoints, verified, problemId, role]);
  // A new pause scrolls its line into view once the editor shows; a frame after the hidden-view restore runs last.
  const revealed = useRef('');
  useEffect(() => {
    const handle = debugHandle.current;
    if (!handle) return;
    handle.setExecution(currentLine ?? null, frameLine ?? null, false);
    if (!revealKey || revealed.current === revealKey || !visible || !(currentLine || frameLine)) return;
    const frame = requestAnimationFrame(() => { revealed.current = revealKey; handle.setExecution(currentLine ?? null, frameLine ?? null, true); });
    return () => cancelAnimationFrame(frame);
  }, [currentLine, frameLine, revealKey, visible, problemId, role]);
  useEffect(() => { debugHandle.current?.setInline(inline ?? []); }, [inline, problemId, role]);
  useEffect(() => { debugHandle.current?.setPaused(!!paused); }, [paused, problemId, role]);
  useEffect(() => { debugHandle.current?.setHover(hover ?? null); }, [hover, problemId, role]);
  useEffect(() => {
    const model = instance.current?.getModel();
    if (model) monaco.editor.setModelMarkers(model, 'javac', diagnostics.filter(d => d.line > 0).map(d => ({ startLineNumber: d.line, endLineNumber: d.line, startColumn: Math.max(1, d.column), endColumn: Math.max(2, d.column + 1), message: d.message, severity: monaco.MarkerSeverity.Error })));
  }, [diagnostics, problemId, role]);
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
  return <section ref={panel} className={`panel code-panel role-${role} ${compact ? 'is-compact' : ''}`} aria-label={`${roleLabels[role]} Java 编辑器`} onKeyDown={event => {
    if (event.key === 'Escape' && popover) { event.stopPropagation(); setPopover(null); instance.current?.focus(); }
  }}>
    {/* Side by side, each editor has a heading with room for the debug controls; the single tabbed editor floats them. */}
    {!compact && <div className="panel-heading code-heading"><strong title={roleDetails[role]}>{roleLabels[role]}</strong>{debug?.toolbar}</div>}
    <div className="editor-host" ref={host} />
    {compact && debug?.toolbar}
    {popover && <div className={`java-popover ${popover === 'structure' ? 'java-outline' : 'java-shortcuts'}`} role="region" aria-label={popover === 'structure' ? `${roleLabels[role]}文件结构列表` : 'Java 编辑器快捷键列表'}>
      <div className="java-popover-heading"><strong>{popover === 'structure' ? 'Main.java · 文件结构' : 'IDEA 风格快捷键'}</strong><button className="icon-button" aria-label="关闭编辑器工具" onClick={() => { setPopover(null); instance.current?.focus(); }}><X size={13} /></button></div>
      {popover === 'structure' ? <div className="java-symbols">{analysis.symbols.length ? analysis.symbols.map((symbol, index) => <button key={`${symbol.start}-${index}`} title={symbol.detail} onClick={() => goToOffset(symbol.selectionStart, symbol.selectionEnd)}><span className={`java-symbol-kind kind-${symbol.kind}`}>{['class', 'interface', 'enum'].includes(symbol.kind) ? 'C' : symbol.kind === 'field' ? 'F' : 'M'}</span><span>{symbol.name}<small>{symbol.detail}</small></span></button>) : <p className="java-tool-empty">{analysis.status === 'checking' ? '正在分析文件结构…' : '暂无可显示的类或方法。'}</p>}</div> : <><dl>{javaShortcuts.map(([key, description]) => <div key={key}><dt>{description}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl><p className="java-tool-note">模板：psvm / main、sout、soutv、fori、iter、fastio。输入后选择补全项，Tab 切换占位符。</p></>}
    </div>}
    {showProblems && problemCount > 0 && <div className="java-problems" aria-label={`${roleLabels[role]}代码问题`}>
      {analysis.status === 'ready' ? analysis.diagnostics.filter(d => d.severity !== 'info').slice(0, 100).map((diagnostic, index) => <button className={diagnostic.severity === 'error' ? 'error-text' : 'warning-text'} key={index} title={diagnostic.message} onClick={() => goToOffset(diagnostic.start, diagnostic.end)}><AlertTriangle size={12} /><span>{diagnostic.message}</span></button>) : diagnostics.map((diagnostic, index) => <button className="error-text" key={index} onClick={() => { const editor = instance.current; editor?.setPosition({ lineNumber: Math.max(1, diagnostic.line), column: Math.max(1, diagnostic.column) }); editor?.revealLineInCenterIfOutsideViewport(Math.max(1, diagnostic.line)); editor?.focus(); }}><AlertTriangle size={12} /><span>{diagnostic.message}</span></button>)}
    </div>}
    <div className="editor-footer edge-bar-bottom"><span className="cursor-position" title={`${code.split('\n').length} 行 · UTF-8 · 4 空格`}>{cursor.lineNumber}:{cursor.column}</span><button className={`java-check-state ${problemCount ? analysis.status !== 'ready' || errors.length ? 'error-text' : 'warning-text' : ''}`} title={actionError || (analysis.status === 'unavailable' ? '本地 Java 分析暂不可用；继续输入会重试。' : '即时编译检查；F2 跳转到下一个问题。')} aria-busy={analysis.status === 'checking' || !!analysis.stale} aria-expanded={showProblems} onClick={() => setShowProblems(value => !value)}>
      {analysis.status === 'checking' ? '检查中…' : problemCount ? analysis.status === 'ready' ? errors.length ? `${errors.length} 个错误${warnings.length ? ` · ${warnings.length} 个警告` : ''}` : `${warnings.length} 个警告` : `${diagnostics.length} 个编译错误` : analysis.status === 'unavailable' ? 'Java 检查不可用' : '无错误'}
    </button><div className="code-actions">
      <button className="icon-button" disabled={locked} title="整理代码缩进（Ctrl+Alt+L）" aria-label={`格式化${roleLabels[role]}代码`} onClick={() => { void runAction('duipai.java.format'); }}><AlignLeft size={13} /></button>
      <button className="icon-button" title="文件结构（Ctrl+F12）" aria-label={`${roleLabels[role]}文件结构`} aria-expanded={popover === 'structure'} onClick={() => setPopover(value => value === 'structure' ? null : 'structure')}><ListTree size={13} /></button>
      <button className="icon-button" title="快捷键" aria-label={`${roleLabels[role]}编辑器快捷键`} aria-expanded={popover === 'shortcuts'} onClick={() => setPopover(value => value === 'shortcuts' ? null : 'shortcuts')}><Keyboard size={13} /></button>
      <button className="icon-button" title="复制代码" aria-label={`复制${roleLabels[role]}代码`} onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
    </div></div>
    {actionError && <div className="java-action-error" role="status">{actionError}<button className="icon-button" aria-label="关闭编辑操作提示" onClick={() => setActionError('')}><X size={12} /></button></div>}
  </section>;
}
