import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { JavaAnalysisClient, JavaAnalysisError } from './javaAnalysisClient';
import {
  JAVA_IMPORTS, JAVA_KEYWORDS, JAVA_TEMPLATES, clampJavaRange, formatJavaIndentation,
  isJavaCodePosition, javaCallSite, javaImportFallback, javaImportPlanner, javaImportSite, javaInspectOffset, javaMethodSnippet, javaWordBounds, scanJava,
  type JavaAnalysis, type JavaCompletion, type JavaCompletionContext, type JavaEditorAnalysisState, type JavaImportPlanner, type JavaOperation, type JavaSymbol,
} from './javaIntelligence';

export type { JavaAnalysis, JavaDiagnostic, JavaEditorAnalysisState, JavaSymbol } from './javaIntelligence';

const MARKER_OWNER = 'java-live';
const ROLE_DOCUMENT = /^\/duipai\/[^/]+\/(?:generator|brute|optimized)\/Main\.java$/;
interface ModelSession { client: JavaAnalysisClient; readOnly: boolean; disposed: boolean; release?: () => void; analysis?: { version: number; result: JavaAnalysis }; importFixes?: Map<string, string[]> }
/** Markers are rebuilt from each analysis; this identifies one across that round trip. */
const fixKey = (marker: { startLineNumber: number; startColumn: number; message: string }) => `${marker.startLineNumber}:${marker.startColumn}:${marker.message}`;
const sessions = new WeakMap<monaco.editor.ITextModel, ModelSession>();

function eligible(model: monaco.editor.ITextModel): boolean {
  return !model.isDisposed() && model.getLanguageId() === 'java' && model.uri.scheme === 'file' && ROLE_DOCUMENT.test(model.uri.path) && !sessions.get(model)?.readOnly;
}

function sessionFor(model: monaco.editor.ITextModel): ModelSession {
  const existing = sessions.get(model);
  if (existing && !existing.disposed) return existing;
  const session: ModelSession = { client: new JavaAnalysisClient(), readOnly: false, disposed: false };
  sessions.set(model, session);
  const changes = model.onDidChangeContent(event => {
    session.client.invalidate(model.getVersionId()); session.analysis = undefined;
    session.client.edited(Math.min(...event.changes.map(change => change.rangeOffset)));
  });
  const disposal = model.onWillDispose(() => session.release?.());
  session.release = () => {
    if (session.disposed) return;
    session.disposed = true;
    changes.dispose(); disposal.dispose(); session.client.dispose();
    if (sessions.get(model) === session) sessions.delete(model);
  };
  return session;
}

function rangeFor(model: monaco.editor.ITextModel, start: number, end: number): monaco.Range {
  const bounded = clampJavaRange(model.getValueLength(), start, end);
  const from = model.getPositionAt(bounded.start), to = model.getPositionAt(bounded.end);
  return new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
}

async function requestAt(model: monaco.editor.ITextModel, operation: JavaOperation, offset: number | undefined, token: monaco.CancellationToken): Promise<JavaAnalysis | undefined> {
  if (!eligible(model) || token.isCancellationRequested) return undefined;
  const session = sessionFor(model), version = model.getVersionId();
  if (operation === 'analyze' && session.analysis?.version === version) return session.analysis.result;
  const abort = new AbortController();
  const subscription = token.onCancellationRequested(() => abort.abort());
  try {
    const result = await session.client.request(model.getValue(), version, operation, offset, abort.signal);
    if (!eligible(model) || token.isCancellationRequested || model.getVersionId() !== version || session.disposed) return undefined;
    if (operation === 'analyze') session.analysis = { version, result };
    return result;
  } catch { return undefined; }
  finally { subscription.dispose(); }
}

/** Completion is not tied to a model version: Monaco re-filters a late result against what was typed since. */
async function completeAt(model: monaco.editor.ITextModel, site: CompletionSite, offset: number, token: monaco.CancellationToken): Promise<JavaAnalysis | undefined> {
  if (!eligible(model) || token.isCancellationRequested) return undefined;
  const session = sessionFor(model);
  const abort = new AbortController();
  const subscription = token.onCancellationRequested(() => abort.abort());
  try {
    const result = await session.client.complete(site.source, site.word.start, site.word.end, offset, abort.signal);
    return !eligible(model) || token.isCancellationRequested || session.disposed ? undefined : result;
  } catch { return undefined; }
  finally { subscription.dispose(); }
}

/** Signature help is not tied to a model version either: typing inside an argument keeps the call's answer. */
async function signatureAt(model: monaco.editor.ITextModel, call: { open: number; commas: number }, offset: number, token: monaco.CancellationToken): Promise<JavaAnalysis | undefined> {
  if (!eligible(model) || token.isCancellationRequested) return undefined;
  const session = sessionFor(model);
  const abort = new AbortController();
  const subscription = token.onCancellationRequested(() => abort.abort());
  try {
    const result = await session.client.signature(model.getValue(), call.open, call.commas, offset, abort.signal);
    return !eligible(model) || token.isCancellationRequested || session.disposed ? undefined : result;
  } catch { return undefined; }
  finally { subscription.dispose(); }
}

/** Per-editor lifecycle, leaving run-time javac markers under their own owner. */
export function attachJavaAnalysis(editor: monaco.editor.IStandaloneCodeEditor, callback: (state: JavaEditorAnalysisState) => void): monaco.IDisposable {
  const attachedModel = editor.getModel();
  if (!attachedModel || !ROLE_DOCUMENT.test(attachedModel.uri.path)) return { dispose() {} };
  const model = attachedModel;
  const session = sessionFor(model);
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  // The last result on screen. Like IDEA and VS Code, an edit keeps it (Monaco moves its squiggles with the text)
  // until the next check replaces it, instead of blanking errors and counts at every keystroke.
  let shown: JavaEditorAnalysisState | undefined;
  session.readOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
  const emit = (state: JavaEditorAnalysisState) => { if (!disposed) callback(state); };
  const clearMarkers = () => { if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []); };
  const idle = () => { shown = undefined; clearMarkers(); emit({ status: 'ready', diagnostics: [], symbols: [] }); };
  const schedule = (delay = 700, retry = false) => {
    if (timer) clearTimeout(timer);
    if (!retry) attempt = 0;
    if (disposed || !eligible(model)) { idle(); return; }
    if (!retry) {
      if (shown) { if (!shown.stale) emit(shown = { ...shown, stale: true }); }
      else {
        clearMarkers();
        emit({ status: 'checking', diagnostics: [], symbols: [] });
      }
    }
    const version = model.getVersionId();
    timer = setTimeout(async () => {
      timer = undefined;
      if (disposed || !eligible(model) || version !== model.getVersionId()) return;
      try {
        const result = await session.client.request(model.getValue(), version, 'analyze');
        if (disposed || !eligible(model) || version !== model.getVersionId()) return;
        session.analysis = { version, result };
        const markers = (result.diagnostics || []).map(diagnostic => ({
          ...rangeFor(model, diagnostic.start, diagnostic.end),
          message: diagnostic.message, code: diagnostic.code, source: 'Java',
          severity: diagnostic.severity === 'error' ? monaco.MarkerSeverity.Error : diagnostic.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        }));
        session.importFixes = new Map(markers.flatMap((marker, index) => result.diagnostics[index].imports?.length ? [[fixKey(marker), result.diagnostics[index].imports!] as const] : []));
        monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
        emit(shown = { status: 'ready', diagnostics: result.diagnostics || [], symbols: result.symbols || [] });
      } catch (error) {
        if (disposed || !eligible(model) || version !== model.getVersionId()) return;
        const retry = error instanceof JavaAnalysisError && error.status === 429 && attempt++ === 0;
        // A busy service gets one retry; meanwhile the last result stays rather than flashing "unavailable".
        if (!retry || !shown) {
          shown = undefined; clearMarkers();
          emit({ status: 'unavailable', diagnostics: [], symbols: [] });
        }
        if (retry) schedule(900, true);
      }
    }, delay);
  };
  const content = model.onDidChangeContent(() => schedule());
  const configuration = editor.onDidChangeConfiguration(event => {
    if (!event.hasChanged(monaco.editor.EditorOption.readOnly)) return;
    session.readOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
    session.client.invalidate(-1);
    schedule();
  });
  const modelChanged = editor.onDidChangeModel(() => dispose());
  const modelDisposed = model.onWillDispose(() => dispose());
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    content.dispose(); configuration.dispose(); modelChanged.dispose(); modelDisposed.dispose();
    session.release?.();
    clearMarkers();
  }
  schedule();
  return { dispose };
}

const completionKinds: Record<JavaCompletion['kind'], monaco.languages.CompletionItemKind> = {
  method: monaco.languages.CompletionItemKind.Method, field: monaco.languages.CompletionItemKind.Field,
  variable: monaco.languages.CompletionItemKind.Variable, class: monaco.languages.CompletionItemKind.Class,
  package: monaco.languages.CompletionItemKind.Module, keyword: monaco.languages.CompletionItemKind.Keyword,
};
const symbolKinds: Record<JavaSymbol['kind'], monaco.languages.SymbolKind> = {
  class: monaco.languages.SymbolKind.Class, interface: monaco.languages.SymbolKind.Interface,
  enum: monaco.languages.SymbolKind.Enum, method: monaco.languages.SymbolKind.Method,
  constructor: monaco.languages.SymbolKind.Constructor, field: monaco.languages.SymbolKind.Field,
};

/** The source as it was when Monaco asked; a late result is mapped against this snapshot, not the live model. */
interface CompletionSite { source: string; word: { start: number; end: number }; range: monaco.IRange; imports: () => JavaImportPlanner }

function completionSite(source: string, lexical: ReturnType<typeof scanJava>, word: { start: number; end: number }, range: monaco.IRange): CompletionSite {
  let planner: JavaImportPlanner | undefined;
  return { source, word, range, imports: () => planner ??= javaImportPlanner(source, lexical) };
}

function snapshotRange(source: string, offset: number): monaco.IRange {
  const lineNumber = (source.slice(0, offset).match(/\n/g)?.length ?? 0) + 1;
  const column = offset - (source.lastIndexOf('\n', offset - 1) + 1) + 1;
  return { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column };
}

function completionWithImport(site: CompletionSite, completion: JavaCompletion, sortText: string): monaco.languages.CompletionItem {
  const { source, word, range } = site;
  const item: monaco.languages.CompletionItem = { ...completion, kind: completionKinds[completion.kind], range, sortText };
  if (completion.deprecated) item.tags = [monaco.languages.CompletionItemTag.Deprecated];
  let text = completion.insertText;
  if (completion.importName) {
    const imports = site.imports(), edit = imports.edit(completion.importName);
    if (imports.conflicts(completion.importName) || (edit && edit.offset >= word.start && edit.offset <= word.end)) {
      const simple = new RegExp(`\\b${completion.importName.slice(completion.importName.lastIndexOf('.') + 1)}\\b`);
      if (simple.test(text)) {
        text = text.replace(simple, completion.importName);
        item.detail = `${completion.detail} · 使用完整类名`;
      }
    } else if (edit) {
      item.additionalTextEdits = [{ range: snapshotRange(source, edit.offset), text: edit.text }];
      item.detail = `${completion.detail} · 自动导入 ${completion.importName}`;
    }
  }
  item.insertText = text;
  const lineEnd = source.indexOf('\n', word.end), following = source.slice(word.end, lineEnd < 0 ? source.length : lineEnd);
  const methodSnippet = completion.kind === 'method' ? javaMethodSnippet(completion.insertText, completion.detail) : null;
  if (methodSnippet) {
    const name = completion.insertText.slice(0, completion.insertText.indexOf('('));
    if (/^\s*\(/.test(following)) item.insertText = name;
    else {
      item.insertText = methodSnippet.insertText;
      item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      if (methodSnippet.hasParameters) item.command = { id: 'editor.action.triggerParameterHints', title: '参数提示' };
    }
  } else if (completion.kind === 'class' && text.endsWith('()')) {
    // After `new`: `ArrayList<>(|)`, or only the name when the code already continues with `(` or `<`.
    const name = text.slice(0, -2);
    if (/^\s*[(<]/.test(following)) item.insertText = name.replace(/<>$/, '');
    else {
      item.insertText = `${name.replace(/\$/g, '\\$')}(\${1})$0`;
      item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      item.command = { id: 'editor.action.triggerParameterHints', title: '参数提示' };
    }
  } else if (text.endsWith('.')) {
    // An import's package, or the type before a static member, goes on: list the next segment right away.
    item.command = { id: 'editor.action.triggerSuggest', title: '继续补全' };
  }
  return item;
}

/**
 * Templates, plus common JDK classes and keywords for when the compiler does not answer (`undefined`).
 * Once it has classified the position, it supplies classes and keywords itself and decides where
 * templates belong.
 */
function localCompletions(site: CompletionSite, context: JavaCompletionContext | null | undefined): monaco.languages.CompletionItem[] {
  if (context === 'name') return [];
  const { range } = site;
  const templates = JAVA_TEMPLATES.filter(template => context === undefined || template.context === context);
  return [
    ...templates.map(template => ({ label: template.label, detail: template.detail, insertText: template.insertText, kind: monaco.languages.CompletionItemKind.Snippet, range, sortText: `1_${template.label}`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })),
    ...(context !== undefined ? [] : Object.entries(JAVA_IMPORTS).map(([label, importName]) => completionWithImport(site, { label, kind: 'class', detail: importName, insertText: label, importName }, `2_${label}`))),
    ...(context !== undefined ? [] : JAVA_KEYWORDS.filter(label => !JAVA_TEMPLATES.some(template => template.label === label)).map(label => ({ label, kind: monaco.languages.CompletionItemKind.Keyword, insertText: label, range, sortText: `3_${label}` }))),
  ];
}

function documentSymbols(model: monaco.editor.ITextModel, symbols: JavaSymbol[]): monaco.languages.DocumentSymbol[] {
  const roots: monaco.languages.DocumentSymbol[] = [];
  const stack: { source: JavaSymbol; item: monaco.languages.DocumentSymbol }[] = [];
  for (const source of [...symbols].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const item: monaco.languages.DocumentSymbol = {
      name: source.name, detail: source.detail, kind: symbolKinds[source.kind], tags: [],
      range: rangeFor(model, source.start, source.end), selectionRange: rangeFor(model, source.selectionStart, source.selectionEnd), children: [],
    };
    while (stack.length && !(stack.at(-1)!.source.start <= source.start && source.end <= stack.at(-1)!.source.end && stack.at(-1)!.source.end > source.end)) stack.pop();
    if (stack.length) stack.at(-1)!.item.children!.push(item); else roots.push(item);
    stack.push({ source, item });
  }
  return roots;
}

let registration: { references: number; disposables: monaco.IDisposable[] } | undefined;

/** Register once for all editors. Multiple mounts safely share the registrations. */
export function registerJavaLanguage(): monaco.IDisposable {
  if (!registration) {
    const disposables: monaco.IDisposable[] = [];
    disposables.push(monaco.languages.registerCompletionItemProvider('java', {
      triggerCharacters: ['.'],
      async provideCompletionItems(model, position, _context, token) {
        if (!eligible(model)) return { suggestions: [] };
        const source = model.getValue(), offset = model.getOffsetAt(position), lexical = scanJava(source);
        if (!isJavaCodePosition(source, offset, lexical)) return { suggestions: [] };
        const word = javaWordBounds(source, offset);
        const site = completionSite(source, lexical, word, rangeFor(model, word.start, word.end));
        const member = /\.\s*[\w$]*$/.test(source.slice(0, offset)), importing = javaImportSite(lexical.code, word.start);
        // Templates and keywords remain usable when the compiler is unavailable.
        const backend = completeAt(model, site, offset, token);
        let completionTimer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          backend,
          new Promise<undefined>(resolve => { completionTimer = setTimeout(() => resolve(undefined), member || importing ? 1500 : 450); }),
        ]);
        if (completionTimer) clearTimeout(completionTimer);
        if (token.isCancellationRequested || model.isDisposed()) return { suggestions: [] };
        // The compiler ranks its candidates; keep that order for items Monaco scores equally.
        const remote = (result?.completions || []).map((completion, index) => completionWithImport(site, completion, `0_${String(index).padStart(4, '0')}`));
        let local: monaco.languages.CompletionItem[];
        if (importing) {
          // Neither templates nor auto-imported classes belong inside an import; offline it completes from the known class names.
          const lineEnd = lexical.code.indexOf('\n', word.end), following = lexical.code.slice(word.end, lineEnd < 0 ? undefined : lineEnd);
          local = result ? [] : javaImportFallback(importing, following).map(completion => completionWithImport(site, completion, `2_${completion.label}`));
        } else local = member ? [] : localCompletions(site, result ? result.context ?? null : undefined);
        const seen = new Set<string>();
        return { suggestions: [...remote, ...local].filter(item => {
          const label = typeof item.label === 'string' ? item.label : item.label.label;
          const key = `${item.kind}:${label}:${item.insertText}${item.kind === monaco.languages.CompletionItemKind.Method ? `:${item.detail}` : ''}`;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        }), incomplete: !result || !!result.incomplete };
      },
    }));
    disposables.push(monaco.languages.registerHoverProvider('java', {
      async provideHover(model, position, token) {
        if (!eligible(model) || !isJavaCodePosition(model.getValue(), model.getOffsetAt(position))) return undefined;
        const result = await requestAt(model, 'inspect', javaInspectOffset(model.getValue(), model.getOffsetAt(position)), token);
        if (!result?.hover) return undefined;
        return { range: rangeFor(model, result.hover.start, result.hover.end), contents: [{ value: `\`\`\`java\n${result.hover.contents.replace(/```/g, '')}\n\`\`\``, isTrusted: false, supportHtml: false }] };
      },
    }));
    disposables.push(monaco.languages.registerDefinitionProvider('java', {
      async provideDefinition(model, position, token) {
        if (!eligible(model) || !isJavaCodePosition(model.getValue(), model.getOffsetAt(position))) return undefined;
        const result = await requestAt(model, 'inspect', javaInspectOffset(model.getValue(), model.getOffsetAt(position)), token);
        return result?.definition ? { uri: model.uri, range: rangeFor(model, result.definition.start, result.definition.end) } : undefined;
      },
    }));
    disposables.push(monaco.languages.registerDocumentSymbolProvider('java', {
      displayName: 'Java 编译器',
      async provideDocumentSymbols(model, token) {
        const result = await requestAt(model, 'analyze', undefined, token);
        return result ? documentSymbols(model, result.symbols || []) : [];
      },
    }));
    disposables.push(monaco.languages.registerSignatureHelpProvider('java', {
      signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [',', ')'],
      async provideSignatureHelp(model, position, token) {
        if (!eligible(model)) return undefined;
        const source = model.getValue(), offset = model.getOffsetAt(position), lexical = scanJava(source);
        if (!isJavaCodePosition(source, offset, lexical)) return undefined;
        const call = javaCallSite(lexical.code, offset);
        if (!call) return undefined;
        const result = await signatureAt(model, call, offset, token);
        if (!result?.signatures?.length) return undefined;
        return {
          value: { signatures: result.signatures.map(signature => ({ label: signature.label, parameters: signature.parameters.map(label => ({ label })) })), activeSignature: 0, activeParameter: Math.max(0, result.activeParameter || 0) },
          dispose() {},
        };
      },
    }));
    disposables.push(monaco.languages.registerCodeActionProvider('java', {
      provideCodeActions(model, range, context, token) {
        if (!eligible(model) || token.isCancellationRequested || (context.only && !context.only.startsWith('quickfix'))) return { actions: [], dispose() {} };
        const source = model.getValue(), version = model.getVersionId(), lexical = scanJava(source);
        let planner: JavaImportPlanner | undefined;
        const actions: monaco.languages.CodeAction[] = [];
        const positions = context.markers.filter(marker => /cant\.resolve|doesnt\.exist|cannot find symbol|找不到符号|无法解析/i.test(`${typeof marker.code === 'string' ? marker.code : ''} ${marker.message}`)).map(marker => ({ lineNumber: marker.startLineNumber, column: marker.startColumn, marker }));
        if (context.trigger === monaco.languages.CodeActionTriggerType.Invoke) positions.push({ lineNumber: range.startLineNumber, column: range.startColumn, marker: undefined as unknown as monaco.editor.IMarkerData });
        const seen = new Set<string>(), fixes = sessions.get(model)?.importFixes;
        for (const position of positions) {
          if (!isJavaCodePosition(source, model.getOffsetAt(position), lexical)) continue;
          const word = model.getWordAtPosition(position);
          const known = position.marker && fixes?.get(fixKey(position.marker));
          const candidates = known?.length ? known : word && JAVA_IMPORTS[word.word] ? [JAVA_IMPORTS[word.word]] : [];
          for (const importName of candidates) {
            if (seen.has(importName)) continue;
            const edit = (planner ??= javaImportPlanner(source, lexical)).edit(importName);
            if (!edit) continue;
            seen.add(importName);
            actions.push({
              title: `导入 ${importName}`, kind: 'quickfix', isPreferred: actions.length === 0, diagnostics: position.marker ? [position.marker] : [],
              edit: { edits: [{ resource: model.uri, versionId: version, textEdit: { range: rangeFor(model, edit.offset, edit.offset), text: edit.text } }] },
            });
          }
        }
        return { actions, dispose() {} };
      },
    }, { providedCodeActionKinds: ['quickfix'] }));
    disposables.push(monaco.languages.registerDocumentFormattingEditProvider('java', {
      displayName: 'Java 安全缩进（保留注释和文本块）',
      provideDocumentFormattingEdits(model, options, token) {
        if (!eligible(model) || token.isCancellationRequested) return [];
        const source = model.getValue(), formatted = formatJavaIndentation(source, options);
        return source === formatted ? [] : [{ range: model.getFullModelRange(), text: formatted }];
      },
    }));
    registration = { references: 0, disposables };
  }
  const shared = registration;
  shared.references++;
  let disposed = false;
  return { dispose() { if (disposed) return; disposed = true; if (--shared.references === 0) { shared.disposables.forEach(item => item.dispose()); if (registration === shared) registration = undefined; } } };
}
