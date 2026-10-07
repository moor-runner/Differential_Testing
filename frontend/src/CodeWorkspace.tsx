import { useRef, useState } from 'react';
import { Code2 } from 'lucide-react';
import { CodeEditor } from './CodeEditor';
import { Results } from './Results';
import { Split } from './Split';
import { readDisplayPreferences, tabDestination } from './displayPreferences';
import { roleLabels, roles, type Job, type Layout, type Problem, type Role } from './types';

interface Props { problem: Problem; job: Job | null; history: Job[]; historical: boolean; busy: boolean; layout: Layout; changeLayout: (id: string, sizes: number[]) => void; onCodeChange: (role: Role, value: string) => void; onReplay: (seed: string) => void; onSelectRun: (id: string) => void; historyLoading: boolean; fullscreen?: boolean }

export function CodeWorkspace({ problem, job, history, historical, busy, layout, changeLayout, onCodeChange, onReplay, onSelectRun, historyLoading, fullscreen = false }: Props) {
  const { mode, activeTab } = readDisplayPreferences(layout);
  const tabbed = mode === 'tabs';
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusRequest, setFocusRequest] = useState({ index: -1, token: 0 });
  const [liveErrors, setLiveErrors] = useState<{ problemId: string; counts: Partial<Record<Role, number | null>> }>({ problemId: problem.id, counts: {} });
  function select(index: number, focusEditor = false) {
    changeLayout('codeTab', [index]);
    if (focusEditor) setFocusRequest(previous => ({ index, token: previous.token + 1 }));
  }
  function diagnostics(role: Role) { return job?.problemId === problem.id && job.codes?.[role] === problem.codes[role] ? job.compileErrors?.find(error => error.role === role)?.diagnostics || [] : []; }
  function errorCount(role: Role) { return (liveErrors.problemId === problem.id ? liveErrors.counts[role] : null) ?? diagnostics(role).length; }
  function updateErrors(role: Role, count: number | null) { setLiveErrors(previous => previous.problemId === problem.id && previous.counts[role] === count ? previous : { problemId: problem.id, counts: { ...(previous.problemId === problem.id ? previous.counts : {}), [role]: count } }); }

  return <Split direction="vertical" sizes={layout.workspace} onChange={sizes => changeLayout('workspace', sizes)} label="代码与结果高度" activePane={tabbed || fullscreen ? 0 : undefined}>
    <div className={`editor-group ${tabbed ? 'is-tabbed' : ''}`} onKeyDownCapture={event => {
      if (tabbed && event.ctrlKey && event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); select((activeTab + (event.shiftKey ? 2 : 1)) % 3, true); }
    }}>
      <div className="code-tabs-bar" hidden={!tabbed}>
        <div className="code-tabs" role="tablist" aria-label="Java 代码标签页" onKeyDown={event => {
          const target = tabDestination(activeTab, event.key);
          if (target === undefined) return;
          event.preventDefault(); select(target); tabs.current[target]?.focus();
        }}>{roles.map((role, index) => <button key={role} type="button" ref={element => { tabs.current[index] = element; }} id={`code-tab-${problem.id}-${role}`} role="tab" aria-label={roleLabels[role]} aria-selected={activeTab === index} aria-controls={`code-pane-${problem.id}-${role}`} tabIndex={activeTab === index ? 0 : -1} className={`code-tab role-${role} ${activeTab === index ? 'active' : ''}`} onClick={() => select(index, true)}><Code2 size={14} /><span>{roleLabels[role]}</span><small>Main.java</small>{errorCount(role) > 0 && <span className="tab-error" title={`${errorCount(role)} 个编译错误`}>{errorCount(role)}</span>}</button>)}</div>
        <button className="text-button tab-result-link" onClick={() => changeLayout('uiMode', [0])} title="切换到分栏模式查看运行结果">查看运行结果</button>
      </div>
      <div className="editor-split-host"><Split sizes={layout.editors} onChange={sizes => changeLayout('editors', sizes)} label="代码编辑器宽度" activePane={tabbed ? activeTab : undefined}>{roles.map((role, index) => <div key={role} className="editor-pane" id={`code-pane-${problem.id}-${role}`} role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? `code-tab-${problem.id}-${role}` : undefined}><CodeEditor role={role} code={problem.codes[role]} problemId={problem.id} onChange={value => onCodeChange(role, value)} diagnostics={diagnostics(role)} onDiagnosticsChange={count => updateErrors(role, count)} visible={!tabbed || activeTab === index} focusRequest={focusRequest.index === index ? focusRequest.token : 0} fontSize={fullscreen ? 16 : 12} /></div>)}</Split></div>
    </div>
    <Results job={job} history={history} historical={historical} onReplay={onReplay} onSelectRun={onSelectRun} busy={busy} layout={layout} setLayout={changeLayout} historyLoading={historyLoading} visible={!tabbed && !fullscreen} />
  </Split>;
}
