import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Bug, Check, ChevronDown, ChevronRight, Copy, LoaderCircle, RotateCcw, Square, TriangleAlert } from 'lucide-react';
import { Split } from './Split';
import { bounded } from './output';
import { childRanges, debugResultMessage, debugStatus, debugVerdictLabels, frameLabel, rangeLabel, type ChildRange } from './debugModel';
import type { DebuggerState, DebugEntry } from './useDebugger';
import type { TestCasesState } from './useTestCases';
import { roleLabels, type DebugRole, type DebugSnapshot, type DebugVariable, type Layout, type TestRole } from './types';

interface Props {
  debug: DebuggerState; tests: TestCasesState; testRole: TestRole; switcher: ReactNode;
  layout: Layout; setLayout: (id: string, sizes: number[]) => void; visible: boolean; onClose?: () => void;
  onStart: (role: DebugRole, entry: DebugEntry) => void; onRestart: () => void;
}

const SEP = '\u0001';
const noNodes = new Map<string, Loaded>();
type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; size: number; readable: number; variables: DebugVariable[] };

function verdictTone(session: DebugSnapshot) {
  if (session.state !== 'TERMINATED') return session.pause?.reason === 'exception' ? 'fail' : 'running';
  const verdict = session.result?.verdict;
  return verdict === 'PASS' ? 'pass' : verdict === 'STOPPED' || verdict === 'UNCHECKED' ? 'cancelled' : 'fail';
}

export function DebugPanel({ debug, tests, testRole, switcher, layout, setLayout, visible, onClose, onStart, onRestart }: Props) {
  const session = debug.session;
  return <section className="panel result-panel debug-panel">
    <div className="panel-heading result-heading">
      <div className="panel-title">{switcher}{session && <span className={`verdict ${verdictTone(session)}`}>{debug.active && <span className="status-pulse" />}{debugStatus(session)}</span>}</div>
      <div className="result-actions">
        {session && <span className="debug-case" title="正在调试的用例与程序">{session.label || '用例'} · {roleLabels[session.role]}</span>}
        {session && <button type="button" className="text-button" disabled={debug.starting} onClick={onRestart} title="用当前代码重新调试这个用例（Ctrl+F5）"><RotateCcw size={12} />重新调试</button>}
        {debug.active && <button type="button" className="stop-button" onClick={() => { void debug.stop(); }} title="停止调试（Ctrl+F2）"><Square size={10} fill="currentColor" />停止</button>}
        {onClose && <button type="button" className="icon-button" onClick={onClose} title="收起运行结果" aria-label="收起运行结果"><ChevronDown size={15} /></button>}
      </div>
    </div>
    <div className="result-content">{!session ? <DebugStart tests={tests} testRole={testRole} starting={debug.starting} onStart={onStart} />
      : <div className="debug-body">
        <DebugMessage session={session} />
        {session.compileErrors.length ? <div className="compile-errors">{session.compileErrors.map((error, index) => <div className="compile-error" key={index}><div className="error-section-title">{roleLabels[error.role]}编译失败</div><pre>{bounded(error.output).text}</pre></div>)}</div>
          : <div className="debug-columns"><Split sizes={layout.debug || [20, 46, 34]} onChange={value => setLayout('debug', value)} label="调试面板列宽" visible={visible}>
            <Frames debug={debug} />
            <Variables debug={debug} />
            <ConsoleView debug={debug} />
          </Split></div>}
      </div>}
    </div>
  </section>;
}

function DebugStart({ tests, testRole, starting, onStart }: { tests: TestCasesState; testRole: TestRole; starting: boolean; onStart: (role: DebugRole, entry: DebugEntry) => void }) {
  const [role, setRole] = useState<DebugRole>(testRole === 'brute' ? 'brute' : 'optimized');
  return <div className="empty-state debug-start">
    <h3>在编辑器中断点调试测试用例</h3>
    <p>点击代码行号左侧设置断点（Ctrl+F8），再选一个用例开始调试。程序停下时，当前行在编辑器中高亮，<br />变量的值显示在行尾，悬停变量名可查看取值；F8 单步跳过，F7 单步进入，F9 继续。</p>
    <div className="segmented" role="group" aria-label="调试的程序">{(['optimized', 'brute'] as const).map(value => <button key={value} type="button" className={role === value ? 'selected' : ''} aria-pressed={role === value} onClick={() => setRole(value)}>{roleLabels[value]}</button>)}</div>
    {tests.entries.length ? <div className="debug-start-cases">{tests.entries.map(entry => <button key={entry.key} type="button" className="small-button" disabled={starting} onClick={() => onStart(role, entry)} title={`用${roleLabels[role]}调试${entry.label}`}><Bug size={12} />{entry.label}</button>)}</div>
      : <p className="muted">还没有测试用例：在「测试用例」中添加，或在题面「样例」下写出输入与输出。</p>}
  </div>;
}

function DebugMessage({ session }: { session: DebugSnapshot }) {
  const exception = session.state === 'PAUSED' ? session.pause?.exception : null;
  if (session.state === 'TERMINATED') {
    const verdict = session.result?.verdict;
    return <div className={`result-message ${verdict && !['PASS', 'STOPPED', 'UNCHECKED'].includes(verdict) ? 'warning' : ''}`}><span title={debugResultMessage(session)}>{verdict && <strong className="debug-verdict">{debugVerdictLabels[verdict]}</strong>}{debugResultMessage(session)}</span></div>;
  }
  if (exception) return <div className="result-message warning debug-exception"><TriangleAlert size={13} /><span title={exception.message}>未捕获的异常：{exception.message}</span><em>继续运行会以运行错误结束</em></div>;
  const text = session.state === 'STARTING' ? '正在编译并启动调试 JVM…' : session.state === 'RUNNING' ? '运行中：程序会停在下一个断点；按 F9 暂停，查看它此刻执行到哪里。' : session.message;
  return <div className="result-message"><span title={text}>{text}</span></div>;
}

function Placeholder({ session }: { session: DebugSnapshot }) {
  const text = session.state === 'STARTING' ? '正在启动…' : session.state === 'RUNNING' ? '运行中' : '程序已结束';
  return <div className="debug-placeholder">{session.state !== 'TERMINATED' && <LoaderCircle size={12} className={session.state === 'STARTING' ? 'spin' : undefined} />}{text}</div>;
}

function Frames({ debug }: { debug: DebuggerState }) {
  const session = debug.session!, pause = session.state === 'PAUSED' ? session.pause : null;
  const omitted = pause ? pause.frameCount - pause.frames.length : 0;
  return <div className="debug-column">
    <div className="debug-column-heading">调用栈{pause && <span>{pause.frameCount}</span>}</div>
    {!pause ? <Placeholder session={session} /> : <div className="debug-frames" role="listbox" aria-label="调用栈">
      {pause.frames.map((frame, position) => <div key={frame.index} style={{ display: 'contents' }}>
        {omitted > 0 && position > 0 && frame.index !== pause.frames[position - 1].index + 1 && <div className="debug-frame-gap">… 省略 {omitted} 帧</div>}
        <button type="button" role="option" aria-selected={frame.index === debug.frameIndex} className={`debug-frame ${frame.user ? '' : 'library'} ${frame.index === debug.frameIndex ? 'active' : ''}`}
          title={frame.user ? `${frame.className}.${frame.method} · 第 ${frame.line} 行` : `${frame.className}.${frame.method}（JDK 代码）`} onClick={() => { void debug.selectFrame(frame.index); }}>
          <span>{frameLabel(frame)}</span><small>{frame.className}</small>
        </button>
      </div>)}
    </div>}
  </div>;
}

function CopyValue({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1200); return () => clearTimeout(timer); }, [copied]);
  return <button type="button" className="icon-button debug-var-copy" title="复制值" aria-label="复制值" onClick={event => { event.stopPropagation(); void navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined); }}>{copied ? <Check size={11} /> : <Copy size={11} />}</button>;
}

/** Variables of the selected frame. Expanded paths stay open per method while stepping; values that changed since the last pause are marked. */
function Variables({ debug }: { debug: DebuggerState }) {
  const session = debug.session!, pause = session.state === 'PAUSED' ? session.pause : null, frame = debug.frame;
  const context = pause ? `${session.id}:${session.generation}:${debug.frameIndex}` : '';
  const scope = frame ? `${frame.className}.${frame.method}` : '';
  const expandedByScope = useRef(new Map<string, Set<string>>());
  const [, setExpandedVersion] = useState(0);
  const expanded = expandedByScope.current.get(scope) ?? new Set<string>();
  const [loaded, setLoaded] = useState<{ context: string; nodes: Map<string, Loaded> }>({ context: '', nodes: new Map() });
  const nodes = loaded.context === context ? loaded.nodes : noNodes;
  const pending = useRef(new Set<string>());
  const history = useRef({ context: '', scope: '', current: new Map<string, string>(), previous: new Map<string, string>(), byScope: new Map<string, Map<string, string>>() });
  const h = history.current;
  if (context && h.context !== context) {
    if (h.context) h.byScope.set(h.scope, h.current);
    h.previous = h.byScope.get(scope) ?? new Map();
    h.current = new Map(); h.context = context; h.scope = scope;
  }
  const needed: { key: string; reference: number; start: number; count: number }[] = [];

  useEffect(() => {
    if (!context) return;
    for (const need of needed) {
      const token = `${context}${SEP}${need.key}`;
      if (nodes.has(need.key) || pending.current.has(token)) continue;
      pending.current.add(token);
      const store = (value: Loaded) => setLoaded(previous => ({ context, nodes: new Map(previous.context === context ? previous.nodes : []).set(need.key, value) }));
      store({ status: 'loading' });
      debug.children(need.reference, need.start, need.count)
        .then(page => { if (history.current.context === context) store({ status: 'ready', size: page.size, readable: page.readable, variables: page.variables }); })
        .catch(error => { if (history.current.context === context) store({ status: 'failed', message: error instanceof Error ? error.message : '读取失败' }); })
        .finally(() => pending.current.delete(token));
    }
  });

  function toggle(path: string) {
    const set = new Set(expanded);
    if (!set.delete(path)) set.add(path);
    expandedByScope.current.set(scope, set);
    setExpandedVersion(version => version + 1);
  }
  const keyboard = (path: string) => (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(path); } };

  const rows: ReactNode[] = [];
  function variableRows(variables: DebugVariable[], parent: string, depth: number) {
    const names = new Map<string, number>();
    variables.forEach(variable => {
      // Map keys can repeat as text (distinct objects), so later duplicates get an index.
      const repeat = names.get(variable.name) ?? 0;
      names.set(variable.name, repeat + 1);
      const path = `${parent}${SEP}${variable.name}${repeat ? `${SEP}${repeat}` : ''}`;
      const open = variable.ref > 0 && expanded.has(path);
      const changed = h.previous.has(path) && h.previous.get(path) !== variable.value;
      h.current.set(path, variable.value);
      rows.push(<div key={path} role="treeitem" aria-level={depth + 1} aria-expanded={variable.ref > 0 ? open : undefined} tabIndex={variable.ref > 0 ? 0 : -1}
        className={`debug-var kind-${variable.kind} ${changed ? 'changed' : ''} ${variable.ref > 0 ? 'expandable' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}
        onClick={variable.ref > 0 ? () => toggle(path) : undefined} onKeyDown={variable.ref > 0 ? keyboard(path) : undefined} title={changed ? '自上次暂停以来值已改变' : undefined}>
        <span className={`debug-var-chevron ${open ? 'open' : ''}`}>{variable.ref > 0 && <ChevronRight size={12} />}</span>
        <span className="debug-var-name">{variable.name}</span>
        <span className="debug-var-value" title={variable.value}>{variable.value}</span>
        <span className="debug-var-type" title={variable.type}>{variable.type}</span>
        <CopyValue text={variable.value} />
      </div>);
      if (open) childRows(variable, path, depth + 1, { start: 0, end: variable.size === undefined ? -1 : Math.min(variable.size, variable.readable ?? variable.size) });
    });
  }
  function page(key: string, reference: number, start: number, count: number, depth: number, parent: string) {
    const node = nodes.get(key);
    if (!node) needed.push({ key, reference, start, count });
    if (!node || node.status === 'loading') rows.push(<div key={`${key}-loading`} className="debug-var-note" style={{ paddingLeft: 22 + depth * 14 }}>读取中…</div>);
    else if (node.status === 'failed') rows.push(<div key={`${key}-failed`} className="debug-var-note error-text" style={{ paddingLeft: 22 + depth * 14 }}>{node.message}</div>);
    else if (!node.variables.length) rows.push(<div key={`${key}-empty`} className="debug-var-note" style={{ paddingLeft: 22 + depth * 14 }}>（没有字段）</div>);
    else variableRows(node.variables, parent, depth);
  }
  /** Fields come in one page; elements of big containers nest in ranges of 100. */
  function childRows(variable: DebugVariable, path: string, depth: number, range: ChildRange) {
    if (range.end < 0) { page(path, variable.ref, 0, 1000, depth, path); return; }
    const groups = childRanges(range.start, range.end);
    if (!groups) page(`${path}${SEP}@${range.start}`, variable.ref, range.start, range.end - range.start, depth, path);
    else for (const group of groups) {
      const groupPath = `${path}${SEP}${rangeLabel(group)}`, open = expanded.has(groupPath);
      rows.push(<div key={groupPath} role="treeitem" aria-level={depth + 1} aria-expanded={open} tabIndex={0} className="debug-var kind-range expandable" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => toggle(groupPath)} onKeyDown={keyboard(groupPath)}>
        <span className={`debug-var-chevron ${open ? 'open' : ''}`}><ChevronRight size={12} /></span>
        <span className="debug-var-name">{rangeLabel(group)}</span><span className="debug-var-value muted">{group.end - group.start} 项</span><span />
      </div>);
      if (open) childRows(variable, path, depth + 1, group);
    }
    if (range.start === 0 && variable.readable !== undefined && variable.size !== undefined && variable.readable < variable.size)
      rows.push(<div key={`${path}-limited`} className="debug-var-note" style={{ paddingLeft: 22 + depth * 14 }}>共 {variable.size} 项，仅列出前 {variable.readable} 项</div>);
  }

  const variables = debug.variables;
  if (pause?.exception) variableRows([pause.exception.variable], 'exception', 0);
  if (variables) variableRows(variables, 'frame', 0);
  return <div className="debug-column">
    <div className="debug-column-heading">变量{frame && <span title={`${frame.className}.${frame.method}`}>{frameLabel(frame)}</span>}</div>
    {!pause ? <Placeholder session={session} />
      : !variables ? <div className="debug-placeholder"><LoaderCircle size={12} className="spin" />读取中…</div>
      : !rows.length ? <div className="debug-placeholder">{frame?.user === false ? 'JDK 代码没有局部变量信息' : '这一帧没有局部变量'}</div>
      : <div className="debug-vars" role="tree" aria-label="变量">{rows}</div>}
  </div>;
}

function ConsoleView({ debug }: { debug: DebuggerState }) {
  const [tab, setTab] = useState<'output' | 'input' | 'expected'>('output');
  const host = useRef<HTMLPreElement>(null), stick = useRef(true);
  const { chunks, length, truncated } = debug.console;
  const entry = debug.request?.entry;
  useLayoutEffect(() => { const element = host.current; if (element && stick.current) element.scrollTop = element.scrollHeight; }, [length, tab]);
  const input = bounded(entry?.input), expected = bounded(entry?.expected);
  const tabs = [['output', '输出'], ['input', '输入'], ...(entry?.expected.trim() ? [['expected', '期望'] as const] : [])] as const;
  return <div className="debug-column">
    <div className="debug-column-heading debug-console-tabs" role="tablist" aria-label="控制台">{tabs.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
    {tab === 'output' ? <pre className="debug-console" ref={host} onScroll={event => { const element = event.currentTarget; stick.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 8; }}>
      {chunks.length ? chunks.map((chunk, index) => <span key={index} className={chunk.stream === 'err' ? 'stderr' : undefined}>{chunk.text}</span>) : <span className="muted">{debug.session?.state === 'TERMINATED' ? '（没有输出）' : '程序输出会显示在这里；stderr 为红色。'}</span>}
      {truncated && <span className="muted">{'\n'}（控制台只显示前 1 MiB）</span>}
    </pre>
      : <pre className="debug-console">{(tab === 'input' ? input.text : expected.text) || <span className="muted">（空）</span>}{(tab === 'input' ? input.truncated : expected.truncated) && <span className="muted">{'\n'}（仅显示前 1 MiB）</span>}</pre>}
  </div>;
}
