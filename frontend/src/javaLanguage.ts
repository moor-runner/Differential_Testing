import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { JavaAnalysisClient, JavaAnalysisError } from './javaAnalysisClient';
import {
  JAVA_IMPORTS, JAVA_KEYWORDS, JAVA_TEMPLATES, clampJavaRange, formatJavaIndentation,
  hasJavaImportConflict, isJavaCodePosition, javaImportEdit, javaInspectOffset, javaMethodSnippet, javaWordBounds,
  type JavaAnalysis, type JavaCompletion, type JavaEditorAnalysisState, type JavaOperation, type JavaSymbol,
} from './javaIntelligence';

export type { JavaAnalysis, JavaDiagnostic, JavaEditorAnalysisState, JavaSymbol } from './javaIntelligence';

const MARKER_OWNER = 'java-live';
const ROLE_DOCUMENT = /^\/duipai\/[^/]+\/(?:generator|brute|optimized)\/Main\.java$/;
interface ModelSession { client: JavaAnalysisClient; readOnly: boolean; disposed: boolean; release?: () => void; analysis?: { version: number; result: JavaAnalysis } }
const sessions = new WeakMap<monaco.editor.ITextModel, ModelSession>();

function eligible(model: monaco.editor.ITextModel): boolean {
  return !model.isDisposed() && model.getLanguageId() === 'java' && model.uri.scheme === 'file' && ROLE_DOCUMENT.test(model.uri.path) && !sessions.get(model)?.readOnly;
}

function sessionFor(model: monaco.editor.ITextModel): ModelSession {
  const existing = sessions.get(model);
  if (existing && !existing.disposed) return existing;
  const session: ModelSession = { client: new JavaAnalysisClient(), readOnly: false, disposed: false };
  sessions.set(model, session);
  const changes = model.onDidChangeContent(() => { session.client.invalidate(model.getVersionId()); session.analysis = undefined; });
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

/** Per-editor lifecycle, leaving run-time javac markers under their own owner. */
export function attachJavaAnalysis(editor: monaco.editor.IStandaloneCodeEditor, callback: (state: JavaEditorAnalysisState) => void): monaco.IDisposable {
  const attachedModel = editor.getModel();
  if (!attachedModel || !ROLE_DOCUMENT.test(attachedModel.uri.path)) return { dispose() {} };
  const model = attachedModel;
  const session = sessionFor(model);
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  session.readOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
  const emit = (state: JavaEditorAnalysisState) => { if (!disposed) callback(state); };
  const clearMarkers = () => { if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []); };
  const idle = () => { clearMarkers(); emit({ status: 'ready', diagnostics: [], symbols: [] }); };
  const schedule = (delay = 700, retry = false) => {
    if (timer) clearTimeout(timer);
    if (!retry) attempt = 0;
    if (disposed || !eligible(model)) { idle(); return; }
    if (!retry) {
      clearMarkers();
      emit({ status: 'checking', diagnostics: [], symbols: [] });
    }
    const version = model.getVersionId();
    timer = setTimeout(async () => {
      timer = undefined;
      if (disposed || !eligible(model) || version !== model.getVersionId()) return;
      try {
        const result = await session.client.request(model.getValue(), version, 'analyze');
        if (disposed || !eligible(model) || version !== model.getVersionId()) return;
        session.analysis = { version, result };
        monaco.editor.setModelMarkers(model, MARKER_OWNER, (result.diagnostics || []).map(diagnostic => ({
          ...rangeFor(model, diagnostic.start, diagnostic.end),
          message: diagnostic.message, code: diagnostic.code, source: 'Java',
          severity: diagnostic.severity === 'error' ? monaco.MarkerSeverity.Error : diagnostic.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        })));
        emit({ status: 'ready', diagnostics: result.diagnostics || [], symbols: result.symbols || [] });
      } catch (error) {
        if (disposed || !eligible(model) || version !== model.getVersionId()) return;
        emit({ status: 'unavailable', diagnostics: [], symbols: [] });
        if (error instanceof JavaAnalysisError && error.status === 429 && attempt++ === 0) schedule(900, true);
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
  keyword: monaco.languages.CompletionItemKind.Keyword,
};
const symbolKinds: Record<JavaSymbol['kind'], monaco.languages.SymbolKind> = {
  class: monaco.languages.SymbolKind.Class, interface: monaco.languages.SymbolKind.Interface,
  enum: monaco.languages.SymbolKind.Enum, method: monaco.languages.SymbolKind.Method,
  constructor: monaco.languages.SymbolKind.Constructor, field: monaco.languages.SymbolKind.Field,
};

function completionWithImport(model: monaco.editor.ITextModel, completion: JavaCompletion, range: monaco.IRange): monaco.languages.CompletionItem {
  const item: monaco.languages.CompletionItem = { ...completion, kind: completionKinds[completion.kind], range, sortText: `0_${completion.label}` };
  const methodSnippet = completion.kind === 'method' ? javaMethodSnippet(completion.insertText, completion.detail) : null;
  if (methodSnippet) {
    const name = completion.insertText.slice(0, completion.insertText.indexOf('('));
    const following = model.getLineContent(range.endLineNumber).slice(range.endColumn - 1);
    if (/^\s*\(/.test(following)) item.insertText = name;
    else {
      item.insertText = methodSnippet.insertText;
      item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      if (methodSnippet.hasParameters) item.command = { id: 'editor.action.triggerParameterHints', title: '参数提示' };
    }
  }
  if (!completion.importName) return item;
  const source = model.getValue(), edit = javaImportEdit(source, completion.importName);
  const start = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
  const end = model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
  if (hasJavaImportConflict(source, completion.importName) || (edit && edit.offset >= start && edit.offset <= end)) {
    const simple = completion.importName.slice(completion.importName.lastIndexOf('.') + 1);
    item.insertText = completion.insertText.replace(new RegExp(`\\b${simple}\\b`), completion.importName);
    item.detail = `${completion.detail} · 使用完整类名`;
  } else if (edit) {
    item.additionalTextEdits = [{ range: rangeFor(model, edit.offset, edit.offset), text: edit.text }];
    item.detail = `${completion.detail} · 自动导入 ${completion.importName}`;
  }
  return item;
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
        const source = model.getValue(), offset = model.getOffsetAt(position);
        if (!isJavaCodePosition(source, offset)) return { suggestions: [] };
        const word = javaWordBounds(source, offset);
        const range = rangeFor(model, word.start, word.end);
        const member = /\.\s*[\w$]*$/.test(source.slice(0, offset));
        const local: monaco.languages.CompletionItem[] = member ? [] : [
          ...JAVA_TEMPLATES.map(template => ({ ...template, kind: monaco.languages.CompletionItemKind.Snippet, range, sortText: `1_${template.label}`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })),
          ...Object.entries(JAVA_IMPORTS).map(([label, importName]) => completionWithImport(model, { label, kind: 'class', detail: importName, insertText: label, importName }, range)),
          ...JAVA_KEYWORDS.filter(label => !JAVA_TEMPLATES.some(template => template.label === label)).map(label => ({ label, kind: monaco.languages.CompletionItemKind.Keyword, insertText: label, range, sortText: `3_${label}` })),
        ];
        const version = model.getVersionId();
        // Templates and keywords remain usable when the compiler is unavailable.
        const backend = requestAt(model, 'complete', offset, token);
        let completionTimer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          backend,
          new Promise<undefined>(resolve => { completionTimer = setTimeout(() => resolve(undefined), member ? 1500 : 450); }),
        ]);
        if (completionTimer) clearTimeout(completionTimer);
        if (token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId()) return { suggestions: [] };
        const remote = (result?.completions || []).map(completion => completionWithImport(model, completion, range));
        const seen = new Set<string>();
        return { suggestions: [...remote, ...local].filter(item => {
          const label = typeof item.label === 'string' ? item.label : item.label.label;
          const key = `${item.kind}:${label}:${item.insertText}${item.kind === monaco.languages.CompletionItemKind.Method ? `:${item.detail}` : ''}`;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        }), incomplete: !result };
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
        if (!eligible(model) || !isJavaCodePosition(model.getValue(), model.getOffsetAt(position))) return undefined;
        const result = await requestAt(model, 'signature', model.getOffsetAt(position), token);
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
        const source = model.getValue(), version = model.getVersionId();
        const actions: monaco.languages.CodeAction[] = [];
        const positions = context.markers.filter(marker => /cant\.resolve|doesnt\.exist|cannot find symbol|找不到符号|无法解析/i.test(`${typeof marker.code === 'string' ? marker.code : ''} ${marker.message}`)).map(marker => ({ lineNumber: marker.startLineNumber, column: marker.startColumn, marker }));
        if (context.trigger === monaco.languages.CodeActionTriggerType.Invoke) positions.push({ lineNumber: range.startLineNumber, column: range.startColumn, marker: undefined as unknown as monaco.editor.IMarkerData });
        const seen = new Set<string>();
        for (const position of positions) {
          if (!isJavaCodePosition(source, model.getOffsetAt(position))) continue;
          const word = model.getWordAtPosition(position);
          const importName = word && JAVA_IMPORTS[word.word];
          if (!importName || seen.has(importName)) continue;
          const edit = javaImportEdit(source, importName);
          if (!edit) continue;
          seen.add(importName);
          actions.push({
            title: `导入 ${importName}`, kind: 'quickfix', isPreferred: true, diagnostics: position.marker ? [position.marker] : [],
            edit: { edits: [{ resource: model.uri, versionId: version, textEdit: { range: rangeFor(model, edit.offset, edit.offset), text: edit.text } }] },
          });
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
