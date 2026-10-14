import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditor, noDiagnostics, type EditorDebug } from './CodeEditor';
import { DebugPanel } from './DebugPanel';
import { DebugToolbar } from './DebugToolbar';
import { inlineValues, type InlineValue } from './debugModel';
import type { BreakpointsState } from './useBreakpoints';
import type { DebugEntry, DebuggerState } from './useDebugger';
import { CountdownTimer } from './CountdownTimer';
import { readCountdown } from './countdown';
import { Results } from './Results';
import { TestCases } from './TestCases';
import type { TestCasesState } from './useTestCases';
import { Split } from './Split';
import { readDisplayPreferences, tabDestination, type View } from './displayPreferences';
import { roleDetails, roleLabels, roles, type DebugRole, type Job, type Layout, type Problem, type Role, type TestRole } from './types';

export type ResultPanel = 'results' | 'tests' | 'debug';
const noInline: InlineValue[] = [];

interface Props {
  problem: Problem; job: Job | null; history: Job[]; historical: boolean; busy: boolean; layout: Layout; changeLayout: (id: string, sizes: number[]) => void; onCodeChange: (role: Role, value: string) => void; onReplay: (seed: string) => void; onSelectRun: (id: string) => void; historyLoading: boolean; view: View; resultsOpen: boolean; onToggleResults: () => void; fontSize: number; fullscreen?: boolean; immersive?: boolean; panel: ResultPanel; onPanelChange: (panel: ResultPanel) => void; tests: TestCasesState; testRole: TestRole; onTestRoleChange: (role: TestRole) => void;
  debug: DebuggerState; breakpoints: BreakpointsState; onDebug: (role: DebugRole, entry: DebugEntry) => void; onDebugRestart: () => void; onRunToCursor: (role: DebugRole) => void; onSelectCase: (key: string | null) => void;
}

export function CodeWorkspace({ problem, job, history, historical, busy, layout, changeLayout, onCodeChange, onReplay, onSelectRun, historyLoading, view, resultsOpen, onToggleResults, fontSize, fullscreen = false, immersive = false, panel, onPanelChange, tests, testRole, onTestRoleChange, debug, breakpoints, onDebug, onDebugRestart, onRunToCursor, onSelectCase }: Props) {
  const { activeTab } = readDisplayPreferences(layout);
  const tabbed = view === 'edit';
  // 编辑界面默认收起结果，开始对拍或点击「运行结果」时展开；对拍界面始终显示。
  const showResults = !fullscreen && (!tabbed || resultsOpen);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusRequest, setFocusRequest] = useState({ index: -1, token: 0 });
  const [liveErrors, setLiveErrors] = useState<{ problemId: string; counts: Partial<Record<Role, number | null>> }>({ problemId: problem.id, counts: {} });
  function select(index: number, focusEditor = false) {
    changeLayout('codeTab', [index]);
    if (focusEditor) setFocusRequest(previous => ({ index, token: previous.token + 1 }));
  }
  function diagnostics(role: Role) { return job?.problemId === problem.id && job.codes?.[role] === problem.codes[role] ? job.compileErrors?.find(error => error.role === role)?.diagnostics || noDiagnostics : noDiagnostics; }
  function errorCount(role: Role) { return (liveErrors.problemId === problem.id ? liveErrors.counts[role] : null) ?? diagnostics(role).length; }
  function updateErrors(role: Role, count: number | null) { setLiveErrors(previous => previous.problemId === problem.id && previous.counts[role] === count ? previous : { problemId: problem.id, counts: { ...(previous.problemId === problem.id ? previous.counts : {}), [role]: count } }); }

  // Debugging happens in the editor of the program being debugged: its breakpoints, execution line and inline values.
  const session = debug.session, debugRole = debug.active ? session?.role : undefined;
  const paused = session?.state === 'PAUSED', debugCode = debugRole ? problem.codes[debugRole] : '';
  const verified = useMemo(() => session && session.state !== 'TERMINATED' ? new Map(session.breakpoints.map(item => [item.line, item.verified])) : null, [session?.breakpoints, session?.state]);
  const inline = useMemo(() => debugRole && debug.frame?.user ? inlineValues(debugCode, debug.frame, debug.scope) : noInline, [debugRole, debugCode, debug.frame, debug.scope]);
  const locals = useMemo(() => new Set((debug.variables ?? []).filter(variable => variable.kind !== 'static').map(variable => variable.name)), [debug.variables]);
  const frame = debug.frame;
  const hover = useCallback(() => ({ scope: debug.scope, locals, lines: frame && frame.methodStart > 0 ? [Math.max(1, frame.methodStart - 3), frame.methodEnd + 1] as [number, number] : null }), [debug.scope, locals, frame]);
  const revealKey = session ? `${session.id}:${session.generation}:${debug.frameIndex}` : '';
  // Each pause brings the debugged program's tab to the front.
  useEffect(() => {
    if (!tabbed || !debugRole) return;
    const index = roles.indexOf(debugRole);
    if (readDisplayPreferences(layout).activeTab !== index) changeLayout('codeTab', [index]);
  }, [session?.id, session?.generation, debugRole]);
  function editorDebug(role: Role): EditorDebug | undefined {
    if (role === 'generator') return undefined; // the generator has no test case to debug
    const debugged = debugRole === role;
    return {
      breakpoints: breakpoints.lines[role], verified: debugged ? verified : null,
      toggle: line => breakpoints.toggle(role, line), moved: lines => breakpoints.set(role, lines),
      runToLine: line => { if (debugged && paused) void debug.runToLine(line); },
      currentLine: debugged ? debug.currentLine : null, frameLine: debugged ? debug.frameLine : null,
      inline: debugged ? inline : noInline, hover: debugged && paused ? hover : null, paused: debugged && paused,
      locked: debugged, revealKey: debugged ? revealKey : '',
      toolbar: debugged ? <DebugToolbar debug={debug} compact={tabbed} onRunToCursor={() => onRunToCursor(role)} onRestart={onDebugRestart} /> : null,
    };
  }

  const switcher = <div className="panel-switch" role="tablist" aria-label="结果面板">
    <button type="button" role="tab" aria-selected={panel === 'results'} onClick={() => onPanelChange('results')} title="对拍的反例、错误输出与历史">对拍结果</button>
    <button type="button" role="tab" aria-selected={panel === 'tests'} onClick={() => onPanelChange('tests')} title="运行题面样例与自定义用例（Ctrl+Shift+Enter）">测试用例</button>
    <button type="button" role="tab" aria-selected={panel === 'debug'} onClick={() => onPanelChange('debug')} title="在编辑器中断点调试测试用例（Shift+F9）">调试{debug.active && panel !== 'debug' && <span className="debug-tab-dot" aria-label="调试中" />}</button>
  </div>;

  return <Split direction="vertical" sizes={layout.workspace} onChange={sizes => changeLayout('workspace', sizes)} label="代码与结果高度" activePane={showResults ? undefined : 0}>
    <div className={`editor-group ${tabbed ? 'is-tabbed' : ''}`} onKeyDownCapture={event => {
      if (tabbed && event.ctrlKey && event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); select((activeTab + (event.shiftKey ? 2 : 1)) % 3, true); }
    }}>
      <div className="code-tabs-bar edge-bar-top" hidden={!tabbed}>
        <div className="code-tabs" role="tablist" aria-label="Java 代码标签页" onKeyDown={event => {
          const target = tabDestination(activeTab, event.key);
          if (target === undefined) return;
          event.preventDefault(); select(target); tabs.current[target]?.focus();
        }}>{roles.map((role, index) => <button key={role} type="button" ref={element => { tabs.current[index] = element; }} id={`code-tab-${problem.id}-${role}`} role="tab" aria-label={roleLabels[role]} aria-selected={activeTab === index} aria-controls={`code-pane-${problem.id}-${role}`} tabIndex={activeTab === index ? 0 : -1} className={`code-tab role-${role} ${activeTab === index ? 'active' : ''}`} title={`${roleDetails[role]}（Ctrl+Tab 切换）`} onClick={() => select(index, true)}>{roleLabels[role]}{debugRole === role && <span className="debug-tab-dot" title="调试中" />}{errorCount(role) > 0 && <span className="tab-error" title={`${errorCount(role)} 个编译错误`}>{errorCount(role)}</span>}</button>)}</div>
        {!fullscreen && <button className="text-button results-toggle" aria-pressed={resultsOpen} onClick={onToggleResults} title="显示或收起运行结果">运行结果</button>}
        <CountdownTimer duration={readCountdown(layout)} onDurationChange={seconds => changeLayout('countdown', [seconds])} />
      </div>
      <div className="editor-split-host"><Split sizes={layout.editors} onChange={sizes => changeLayout('editors', sizes)} label="代码编辑器宽度" activePane={tabbed ? activeTab : undefined}>{roles.map((role, index) => <div key={role} className="editor-pane" id={`code-pane-${problem.id}-${role}`} role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? `code-tab-${problem.id}-${role}` : undefined}><CodeEditor role={role} code={problem.codes[role]} problemId={problem.id} onChange={value => onCodeChange(role, value)} diagnostics={diagnostics(role)} onDiagnosticsChange={count => updateErrors(role, count)} visible={!tabbed || activeTab === index} focusRequest={focusRequest.index === index ? focusRequest.token : 0} fontSize={fontSize} compact={tabbed} immersive={immersive} debug={editorDebug(role)} /></div>)}</Split></div>
    </div>
    {panel === 'tests' ? <TestCases tests={tests} role={testRole} onRoleChange={onTestRoleChange} busy={busy} switcher={switcher} layout={layout} setLayout={changeLayout} visible={showResults} onClose={tabbed ? onToggleResults : undefined} onDebug={onDebug} debugStarting={debug.starting} onSelectionChange={onSelectCase} />
      : panel === 'debug' ? <DebugPanel debug={debug} tests={tests} testRole={testRole} switcher={switcher} layout={layout} setLayout={changeLayout} visible={showResults} onClose={tabbed ? onToggleResults : undefined} onStart={onDebug} onRestart={onDebugRestart} />
      : <Results title={switcher} job={job} history={history} historical={historical} onReplay={onReplay} onSelectRun={onSelectRun} busy={busy || tests.testing} layout={layout} setLayout={changeLayout} historyLoading={historyLoading} visible={showResults} onClose={tabbed ? onToggleResults : undefined} onDebug={onDebug} debugStarting={debug.starting} />}
  </Split>;
}
