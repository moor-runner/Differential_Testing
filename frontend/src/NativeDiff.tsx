import { useEffect, useLayoutEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

/** Own both models so they are detached before disposal (Monaco 0.55). */
export function NativeDiff({ original, modified, firstDifferenceLine, visible = true }: { original: string; modified: string; firstDifferenceLine?: number; visible?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const models = useRef<monaco.editor.IDiffEditorModel | null>(null);
  const latest = useRef({ original, modified, firstDifferenceLine, visible });
  latest.current = { original, modified, firstDifferenceLine, visible };
  const hiddenView = useRef<monaco.editor.IDiffEditorViewState | null>(null);

  useLayoutEffect(() => {
    const current = latest.current;
    const originalModel = monaco.editor.createModel(current.original, 'plaintext');
    const modifiedModel = monaco.editor.createModel(current.modified, 'plaintext');
    const editor = monaco.editor.createDiffEditor(host.current!, {
      theme: 'duipai', readOnly: true, renderSideBySide: true,
      renderSideBySideInlineBreakpoint: 0, originalEditable: false,
      automaticLayout: false, minimap: { enabled: false }, fontSize: 12,
      fontFamily: 'Cascadia Code, Consolas, monospace', lineHeight: 20,
      scrollBeyondLastLine: false, ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: false }, diffWordWrap: 'on',
      renderOverviewRuler: false, enableSplitViewResizing: false,
      lineNumbersMinChars: 2, glyphMargin: false, folding: false,
      padding: { top: 10 }, scrollbar: { verticalScrollbarSize: 6 },
    });
    const pair = { original: originalModel, modified: modifiedModel };
    models.current = pair; instance.current = editor;
    const resize = new ResizeObserver(() => { if (latest.current.visible && host.current?.clientWidth && host.current?.clientHeight) editor.layout(); });
    resize.observe(host.current!);
    editor.setModel(pair);
    if (current.firstDifferenceLine) editor.getModifiedEditor().revealLineInCenter(current.firstDifferenceLine);
    return () => {
      instance.current = null; models.current = null;
      resize.disconnect();
      editor.setModel(null);
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, []);
  useLayoutEffect(() => {
    const editor = instance.current;
    if (!editor) return;
    if (!visible) { hiddenView.current = editor.saveViewState(); return; }
    const frame = requestAnimationFrame(() => { editor.layout(); if (hiddenView.current) { editor.restoreViewState(hiddenView.current); hiddenView.current = null; } });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    const pair = models.current;
    if (!pair) return;
    if (pair.original.getValue() !== original) { pair.original.setValue(original); hiddenView.current = null; }
    if (pair.modified.getValue() !== modified) { pair.modified.setValue(modified); hiddenView.current = null; }
    if (firstDifferenceLine) instance.current?.getModifiedEditor().revealLineInCenter(firstDifferenceLine);
  }, [original, modified, firstDifferenceLine]);

  return <div ref={host} style={{ width: '100%', height: '100%' }} aria-label="暴力解与优化解输出差异" />;
}
