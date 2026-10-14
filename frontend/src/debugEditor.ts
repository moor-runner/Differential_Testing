// 编辑器里的断点调试：行号左侧的断点、当前执行行、行内变量值与悬停取值。断点随编辑移动，移动后的行号回报给调用方保存。
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { normalizeLines, sameLines, type InlineValue } from './debugModel';
import { isJavaCodePosition } from './javaIntelligence';
import type { DebugVariable } from './types';

export interface DebugEditorCallbacks {
  toggle(line: number): void;
  /** Edits moved or merged breakpoints; these are the lines they are on now. */
  moved(lines: number[]): void;
  runToLine(line: number): void;
}

/** Names the hover can show while paused: locals only inside the paused method's lines, static fields anywhere. */
export interface DebugHoverScope { scope: ReadonlyMap<string, DebugVariable>; locals: ReadonlySet<string>; lines: [number, number] | null }

export interface DebugEditorHandle extends monaco.IDisposable {
  setBreakpoints(lines: readonly number[], verified: ReadonlyMap<number, boolean> | null): void;
  setExecution(current: number | null, frame: number | null, reveal: boolean): void;
  setInline(values: readonly InlineValue[]): void;
  setPaused(paused: boolean): void;
  setHover(scope: (() => DebugHoverScope | null) | null): void;
}

const stickiness = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
const hovers = new Map<string, () => DebugHoverScope | null>();
let hoverProvider: monaco.IDisposable | undefined;

/** One provider for all editors, answering only for the model being debugged. */
function ensureHoverProvider() {
  hoverProvider ??= monaco.languages.registerHoverProvider('java', {
    provideHover(model, position) {
      const state = hovers.get(model.uri.toString())?.();
      const word = state && model.getWordAtPosition(position);
      if (!state || !word || !isJavaCodePosition(model.getValue(), model.getOffsetAt(position))) return undefined;
      // `a.length`, `list.size`: a member after a dot is not the variable of that name.
      if (model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1).trimEnd().endsWith('.')) return undefined;
      const variable = state.scope.get(word.word);
      if (!variable) return undefined;
      if (state.locals.has(word.word) && state.lines && (position.lineNumber < state.lines[0] || position.lineNumber > state.lines[1])) return undefined;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [
          { value: `**${variable.name}** · \`${variable.type.replace(/`/g, '')}\` · 调试取值` },
          { value: `\`\`\`java\n${variable.value.replace(/```/g, '`​``')}\n\`\`\`` },
        ],
      };
    },
  });
}

/** The mounted editor of one program, e.g. for the cursor line of Alt+F9 from outside the editor. */
export function codeEditorFor(problemId: string, role: string) {
  return monaco.editor.getEditors().find(editor => editor.getModel()?.uri.path === `/duipai/${problemId}/${role}/Main.java`);
}

export function attachDebugEditor(editor: monaco.editor.IStandaloneCodeEditor, callbacks: { current: DebugEditorCallbacks }): DebugEditorHandle {
  const model = editor.getModel()!;
  const breakpoints = editor.createDecorationsCollection(), hint = editor.createDecorationsCollection();
  const execution = editor.createDecorationsCollection(), inline = editor.createDecorationsCollection();
  const paused = editor.createContextKey<boolean>('duipaiDebugPaused', false);
  let lines: number[] = [], verified: ReadonlyMap<number, boolean> | null = null, hintLine: number | undefined;
  ensureHoverProvider();
  const line = (number: number) => new monaco.Range(number, 1, number, 1);

  function render() {
    const count = model.getLineCount();
    breakpoints.set(lines.filter(number => number <= count).map(number => {
      const pending = verified?.get(number) === false;
      return {
        range: line(number),
        options: {
          isWholeLine: true, className: 'debug-breakpoint-line', stickiness,
          glyphMarginClassName: `debug-breakpoint${pending ? ' unverified' : ''}`,
          glyphMarginHoverMessage: { value: pending ? `第 ${number} 行的断点尚未生效：此行没有可执行代码，或所在的类还没有加载。点击移除。` : `第 ${number} 行的断点 · 点击移除（Ctrl+F8）` },
        },
      };
    }));
  }

  const content = model.onDidChangeContent(event => {
    // Replacing the whole text (loading another version) keeps the stored lines rather than collapsing them.
    if (event.isFlush) { render(); return; }
    const moved = normalizeLines(breakpoints.getRanges().map(range => range.startLineNumber));
    const merged = moved.length !== breakpoints.length;
    if (!sameLines(moved, lines)) { lines = moved; callbacks.current.moved(moved); }
    if (merged) render(); // a deleted line folded two breakpoints into one
  });
  const mouseDown = editor.onMouseDown(event => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.event.leftButton) return;
    const number = event.target.position?.lineNumber;
    if (!number) return;
    event.event.preventDefault();
    hint.clear(); hintLine = undefined;
    callbacks.current.toggle(number);
  });
  const mouseMove = editor.onMouseMove(event => {
    const number = event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ? event.target.position?.lineNumber : undefined;
    if (number === hintLine) return;
    hintLine = number;
    hint.set(number && !lines.includes(number) ? [{ range: line(number), options: { glyphMarginClassName: 'debug-breakpoint-hint' } }] : []);
  });
  const mouseLeave = editor.onMouseLeave(() => { hintLine = undefined; hint.clear(); });
  const actions = [
    editor.addAction({
      id: 'duipai.debug.toggleBreakpoint', label: '切换断点', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F8],
      contextMenuGroupId: '1_debug', contextMenuOrder: 1, precondition: 'editorTextFocus',
      run: () => { const position = editor.getPosition(); if (position) callbacks.current.toggle(position.lineNumber); },
    }),
    editor.addAction({
      id: 'duipai.debug.runToCursor', label: '运行到光标处', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F9],
      contextMenuGroupId: '1_debug', contextMenuOrder: 2, precondition: 'duipaiDebugPaused',
      run: () => { const position = editor.getPosition(); if (position) callbacks.current.runToLine(position.lineNumber); },
    }),
  ];
  const key = model.uri.toString();

  return {
    setBreakpoints(next, nextVerified) {
      if (sameLines(next, lines) && nextVerified === verified) return;
      lines = [...next]; verified = nextVerified;
      if (hintLine && lines.includes(hintLine)) hint.clear();
      render();
    },
    setExecution(current, frame, reveal) {
      const decorations: monaco.editor.IModelDeltaDecoration[] = [];
      if (frame) decorations.push({ range: line(frame), options: { isWholeLine: true, className: 'debug-frame-line', glyphMarginClassName: 'debug-frame-glyph', zIndex: 10, stickiness } });
      if (current) decorations.push({ range: line(current), options: { isWholeLine: true, className: 'debug-current-line', glyphMarginClassName: 'debug-current-glyph', zIndex: 20, stickiness } });
      execution.set(decorations);
      const focus = frame ?? current;
      if (reveal && focus) editor.revealLineInCenterIfOutsideViewport(focus, monaco.editor.ScrollType.Immediate);
    },
    setInline(values) {
      const count = model.getLineCount();
      inline.set(values.filter(value => value.line <= count).map(value => {
        const column = model.getLineMaxColumn(value.line);
        return { range: new monaco.Range(value.line, column, value.line, column), options: { showIfCollapsed: true, after: { content: `  ${value.text}`, inlineClassName: 'debug-inline-value', cursorStops: monaco.editor.InjectedTextCursorStops.None } } };
      }));
    },
    setPaused(value) { paused.set(value); },
    setHover(scope) { if (scope) hovers.set(key, scope); else hovers.delete(key); },
    dispose() {
      hovers.delete(key);
      content.dispose(); mouseDown.dispose(); mouseMove.dispose(); mouseLeave.dispose();
      actions.forEach(action => action.dispose());
      breakpoints.clear(); hint.clear(); execution.clear(); inline.clear();
    },
  };
}
