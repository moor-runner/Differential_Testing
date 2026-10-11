import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, MoreHorizontal, PanelLeft, Play, Plus, Search, Square, X } from 'lucide-react';
import { api } from './api';
import { CodeWorkspace } from './CodeWorkspace';
import { DisplayControls } from './DisplayControls';
import { dateTime, verdictText } from './Results';
import { Split } from './Split';
import { Statement } from './Statement';
import { PendingUploads } from './pendingUploads';
import { advanceSnapshot } from './jobSnapshots';
import { readDisplayPreferences, zoomFontSize, type View } from './displayPreferences';
import { useFullscreen } from './useFullscreen';
import { roles, type Health, type Job, type Layout, type Problem, type ProblemSummary, type Settings } from './types';

// statementEdit / statement：编辑界面与对拍界面各自记住题面宽度。
const defaultLayout: Layout = { sidebar: [18, 82], statementEdit: [42, 58], statement: [26, 74], workspace: [62, 38], editors: [33.333, 33.333, 33.334], outputs: [24, 76], codeTab: [2], fontSize: [14] };
type SaveState = 'saved' | 'pending' | 'saving' | 'error';
type Modal = { type: 'create' | 'rename' | 'delete'; title: string } | null;
function message(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试。'; }

export default function App() {
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState('');
  const [bootVersion, setBootVersion] = useState(0);
  const [health, setHealth] = useState<Health | null>(null);
  const [summaries, setSummaries] = useState<ProblemSummary[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const problemRef = useRef<Problem | null>(null);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const savePromise = useRef<Promise<void> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUploads = useRef(new PendingUploads());
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [layout, setLayoutState] = useState<Layout>(defaultLayout);
  const layoutRef = useRef(defaultLayout);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutRevision = useRef(0);
  const layoutSavedRevision = useRef(0);
  const layoutSavePromise = useRef<Promise<void> | null>(null);
  const [query, setQuery] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<Job | null>(null);
  const viewGeneration = useRef(0);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const [historical, setHistorical] = useState(false);
  const [history, setHistory] = useState<Job[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [action, setAction] = useState('');
  const actionRef = useRef(false);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [help, setHelp] = useState(false);
  const [connected, setConnected] = useState(true);
  const [view, setView] = useState<View>('edit');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const busy = !!activeJobId;

  const showError = useCallback((text: string) => setToast(text), []);
  const { fullscreen, changeFullscreen } = useFullscreen(!!problem && !loading && !bootError, showError);
  const displaySnapshot = useCallback((next: Job, expectedJobId?: string) => {
    const applied = advanceSnapshot(jobRef.current, next, expectedJobId);
    if (applied !== jobRef.current) { jobRef.current = applied; setJob(applied); }
    return applied;
  }, []);
  const activateJob = useCallback((id: string | null) => { activeJobRef.current = id; setActiveJobId(id); }, []);
  function clearJob() { viewGeneration.current += 1; jobRef.current = null; setJob(null); }
  function updateSummary(saved: Problem) {
    setSummaries(previous => [...previous.filter(item => item.id !== saved.id), { id: saved.id, title: saved.title, updatedAt: saved.updatedAt }].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  function loadProblem(value: Problem) {
    problemRef.current = value;
    revision.current = savedRevision.current = 0;
    setProblem(value); setSaveState('saved');
    clearJob(); setHistorical(false);
  }
  const refreshHistory = useCallback(async (problemId: string) => {
    setHistoryLoading(true);
    try { const runs = await api.runs(problemId); if (problemRef.current?.id === problemId) setHistory(runs); }
    catch (error) { showError(`读取运行历史失败：${message(error)}`); }
    finally { if (problemRef.current?.id === problemId) setHistoryLoading(false); }
  }, [showError]);

  const forceSave = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    while (savePromise.current) await savePromise.current;
    const operation = async () => {
      while (true) {
        await pendingUploads.current.drain();
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        if (!problemRef.current || savedRevision.current >= revision.current) return;
        const snapshot = structuredClone(problemRef.current);
        const currentRevision = revision.current;
        setSaveState('saving');
        try {
          const saved = await api.save(snapshot);
          updateSummary(saved);
          if (problemRef.current?.id === saved.id) {
            savedRevision.current = currentRevision;
            const updated = { ...problemRef.current, updatedAt: saved.updatedAt };
            problemRef.current = updated; setProblem(updated);
            setSaveState(savedRevision.current >= revision.current ? 'saved' : 'pending');
          }
        } catch (error) { setSaveState('error'); showError(`自动保存失败：${message(error)}。编辑内容仍保留在当前窗口。`); throw error; }
      }
    };
    savePromise.current = operation();
    try { await savePromise.current; } finally { savePromise.current = null; }
  }, [showError]);

  const registerUpload = useCallback((operation: Promise<void>) => pendingUploads.current.add(operation), []);

  function edit(transform: (value: Problem) => Problem) {
    if (!problemRef.current) return;
    const value = transform(problemRef.current);
    problemRef.current = value; revision.current += 1;
    setProblem(value); setSaveState('pending');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void forceSave().catch(() => undefined); }, 1000);
  }
  function setting<K extends keyof Settings>(key: K, value: Settings[K]) { edit(current => ({ ...current, settings: { ...current.settings, [key]: value } })); }
  const forceLayoutSave = useCallback(async () => {
    if (layoutTimer.current) { clearTimeout(layoutTimer.current); layoutTimer.current = null; }
    while (layoutSavePromise.current) await layoutSavePromise.current;
    const operation = async () => {
      while (layoutSavedRevision.current < layoutRevision.current) {
        const version = layoutRevision.current, snapshot = structuredClone(layoutRef.current);
        try { await api.saveLayout(snapshot); layoutSavedRevision.current = version; }
        catch (error) { showError(`布局保存失败：${message(error)}`); throw error; }
      }
    };
    layoutSavePromise.current = operation();
    try { await layoutSavePromise.current; } finally { layoutSavePromise.current = null; }
  }, [showError]);
  const changeLayout = useCallback((id: string, sizes: number[]) => {
    const updated = { ...layoutRef.current, [id]: sizes };
    layoutRef.current = updated; layoutRevision.current += 1; setLayoutState(updated);
    if (layoutTimer.current) clearTimeout(layoutTimer.current);
    layoutTimer.current = setTimeout(() => { void forceLayoutSave().catch(() => undefined); }, 450);
  }, [forceLayoutSave]);
  useEffect(() => {
    if (!window.duipai?.onBeforeClose) return;
    return window.duipai.onBeforeClose(async () => { await forceSave(); await forceLayoutSave(); });
  }, [forceSave, forceLayoutSave]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (revision.current > savedRevision.current || pendingUploads.current.pending) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 9000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setBootError('');
    void (async () => {
      try {
        const [healthResult, problemResult, layoutResult] = await Promise.allSettled([api.health(), api.problems(), api.layout()]);
        if (cancelled) return;
        if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
        if (problemResult.status === 'rejected') throw problemResult.reason;
        const list = problemResult.value;
        setSummaries(list);
        if (layoutResult.status === 'fulfilled') { const restored = { ...defaultLayout, ...layoutResult.value }; layoutRef.current = restored; layoutRevision.current = layoutSavedRevision.current = 0; setLayoutState(restored); }
        if (list.length) {
          const first = await api.problem(list[0].id);
          if (cancelled) return;
          loadProblem(first); void refreshHistory(first.id);
        }
      } catch (error) { if (!cancelled) setBootError(message(error)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [bootVersion, refreshHistory]);
  useEffect(() => {
    if (!activeJobId) return;
    let disposed = false;
    let polling: ReturnType<typeof setInterval> | null = null;
    let pollInFlight = false;
    const source = new EventSource(`/api/jobs/${encodeURIComponent(activeJobId)}/events`, { withCredentials: true });
    function apply(next: Job) {
      if (disposed || activeJobRef.current !== activeJobId) return;
      const applied = displaySnapshot(next, activeJobId!);
      if (applied?.state === 'FINISHED') { source.close(); if (polling) clearInterval(polling); activateJob(null); setConnected(true); void refreshHistory(applied.problemId); }
    }
    async function poll() { if (pollInFlight || disposed || activeJobRef.current !== activeJobId) return; pollInFlight = true; try { apply(await api.job(activeJobId!)); } catch { if (!disposed && activeJobRef.current === activeJobId) setConnected(false); } finally { pollInFlight = false; } }
    source.addEventListener('progress', event => { if (disposed || activeJobRef.current !== activeJobId) return; try { const next = JSON.parse((event as MessageEvent).data) as Job; setConnected(true); if (polling) { clearInterval(polling); polling = null; } apply(next); } catch { /* retain last valid snapshot */ } });
    source.onerror = () => { if (!disposed && activeJobRef.current === activeJobId) { setConnected(false); if (!polling) polling = setInterval(() => { void poll(); }, 450); void poll(); } };
    void poll();
    return () => { disposed = true; source.close(); if (polling) clearInterval(polling); };
  }, [activeJobId, refreshHistory, displaySnapshot, activateJob]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') { setModal(null); setHelp(false); setMenu(false); }
      if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void forceSave().catch(() => undefined); }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [forceSave]);
  // Capture phase runs before Monaco, which otherwise binds Ctrl+Enter to "insert line below".
  const shortcuts = useRef({ start: () => {} });
  shortcuts.current.start = () => { if (!activeJobRef.current && problemRef.current) start(); };
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (document.querySelector('.modal-backdrop, dialog[open]')) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && !event.altKey && !event.shiftKey && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) shortcuts.current.start(); return; }
      const size = command && !event.altKey ? zoomFontSize(readDisplayPreferences(layoutRef.current).fontSize, event.key) : undefined;
      if (size !== undefined) { event.preventDefault(); event.stopPropagation(); changeLayout('fontSize', [size]); return; }
      if (event.altKey && !command && event.code === 'Digit1') { event.preventDefault(); event.stopPropagation(); setSidebarOpen(value => !value); }
    }
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [changeLayout]);
  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => { if (!menuAnchor.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [menu]);

  async function perform(name: string, callback: () => Promise<void>) {
    if (actionRef.current) return;
    actionRef.current = true; setAction(name);
    try { await callback(); } catch (error) { showError(message(error)); } finally { actionRef.current = false; setAction(''); }
  }
  function switchProblem(id: string) {
    if (busy || id === problemRef.current?.id) return;
    void perform('switch', async () => { await forceSave(); const next = await api.problem(id); loadProblem(next); setHistory([]); void refreshHistory(id); });
  }
  function validate() {
    const value = problemRef.current;
    if (!value) throw new Error('请先新建或选择一道题目。');
    if (!Number.isInteger(value.settings.rounds) || value.settings.rounds < 1) throw new Error('最大轮数必须是正整数。');
    if (!Number.isInteger(value.settings.parallelism) || value.settings.parallelism < 1) throw new Error('并行度必须是正整数。');
    for (const role of roles) { const timeout = value.settings[`${role}TimeoutMs`]; if (!Number.isInteger(timeout) || timeout < 1) throw new Error('三个程序的时限都必须是正整数毫秒。'); }
    const seed = value.settings.startSeed?.trim();
    if (seed) { if (!/^-?\d+$/.test(seed)) throw new Error('种子必须是带符号的 64 位整数，或留空使用随机种子。'); const number = BigInt(seed); if (number < -(1n << 63n) || number > (1n << 63n) - 1n) throw new Error('种子超出了 64 位整数范围。'); }
    return value;
  }
  function start(replaySeed?: string) {
    if (activeJobRef.current) return;
    setResultsOpen(true);
    void perform('start', async () => {
      validate(); await forceSave();
      const current = problemRef.current!, generation = viewGeneration.current;
      const next = await api.start(current.id, replaySeed);
      if (viewGeneration.current !== generation || problemRef.current?.id !== current.id) return;
      displaySnapshot(next); setHistorical(false); setConnected(true);
      if (next.state !== 'FINISHED') activateJob(next.id); else void refreshHistory(current.id);
    });
  }
  function stop() {
    const id = activeJobRef.current;
    if (id) void perform('stop', async () => {
      const next = await api.cancel(id);
      const applied = displaySnapshot(next, id);
      if (applied?.id === id && applied.state === 'FINISHED' && activeJobRef.current === id) { activateJob(null); setConnected(true); void refreshHistory(applied.problemId); }
    });
  }
  function selectRun(id: string) {
    if (activeJobRef.current) return;
    void perform('history', async () => {
      const generation = viewGeneration.current, problemId = problemRef.current?.id;
      const next = await api.run(id);
      if (viewGeneration.current !== generation || problemRef.current?.id !== problemId) return;
      displaySnapshot(next); setHistorical(true);
    });
  }
  function submitModal() {
    if (!modal) return;
    const currentModal = modal;
    void perform('modal', async () => {
      if (currentModal.type !== 'delete' && !currentModal.title.trim()) throw new Error('题目标题不能为空。');
      await forceSave();
      if (currentModal.type === 'create') { const created = await api.create(currentModal.title.trim()); updateSummary(created); loadProblem(created); setHistory([]); }
      else if (currentModal.type === 'rename') { edit(value => ({ ...value, title: currentModal.title.trim() })); await forceSave(); }
      else {
        const removedId = problemRef.current!.id;
        await api.remove(removedId);
        const list = summaries.filter(item => item.id !== removedId);
        setSummaries(list); setHistory([]);
        if (list.length) { const next = await api.problem(list[0].id); loadProblem(next); void refreshHistory(next.id); }
        else { problemRef.current = null; setProblem(null); clearJob(); revision.current = savedRevision.current = 0; }
      }
      setModal(null);
    });
  }
  const filtered = summaries.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const available = !!problem && !loading && !bootError;
  const { fontSize } = readDisplayPreferences(layout);
  const readingSize = fullscreen ? fontSize + 2 : fontSize;
  const configDisabled = !available || busy || !!action;
  const numberField = (text: string, label: string, key: 'rounds' | 'parallelism' | 'generatorTimeoutMs' | 'bruteTimeoutMs' | 'optimizedTimeoutMs') => <label className={`config-field field-${key}`}><span>{text}</span><input type="number" min="1" step="1" value={problem?.settings[key] ?? ''} disabled={configDisabled} onChange={event => { const number = event.target.valueAsNumber; if (Number.isFinite(number)) setting(key, number); }} aria-label={label} /></label>;
  const shown = job && problem && job.problemId === problem.id && (!historical || busy) ? job : null;
  const runStatus = action === 'start' ? { tone: 'active', text: '正在启动…' }
    : !shown ? null
    : shown.state === 'COMPILING' ? { tone: 'active', text: '正在编译…' }
    : shown.state === 'RUNNING' ? { tone: 'active', text: `正在对拍 ${shown.completed.toLocaleString()} / ${shown.total.toLocaleString()}${connected ? '' : ' · 连接恢复中'}` }
    : shown.verdict === 'PASS' ? { tone: 'pass', text: `通过 ${shown.completed.toLocaleString()} 轮` }
    : shown.verdict === 'CANCELLED' ? { tone: 'muted', text: '已停止' }
    : { tone: 'fail', text: shown.seed ? `${shown.verdict} · 种子 ${shown.seed}` : `${shown.verdict ?? ''} ${verdictText(shown)}` };
  const saveLabel = saveState === 'saving' ? '正在保存…' : saveState === 'error' ? '保存失败，点击重试' : saveState === 'pending' ? '等待自动保存' : '已保存';
  function menuAction(callback: () => void) { return () => { setMenu(false); callback(); }; }
  return <div className={`app-shell view-${view} ${fullscreen ? 'is-fullscreen' : ''}`}>
    <header className="topbar">
      <div className="topbar-start">
        <button className="icon-button" aria-label="题目列表" aria-pressed={sidebarOpen} title="题目列表（Alt+1）" disabled={loading || !!bootError} onClick={() => setSidebarOpen(value => !value)}><PanelLeft size={16} /></button>
        {problem && <h1 className="topbar-title" title={problem.title}>{problem.title}</h1>}
        {problem && <button className={`save-state state-${saveState}`} onClick={() => { void forceSave().catch(() => undefined); }} title={`${saveLabel}（Ctrl+S）`} aria-label={saveLabel}>{saveState === 'error' ? saveLabel : <span className="save-dot" />}</button>}
        {bootError && <span className="topbar-error">本地服务未连接</span>}
      </div>
      <DisplayControls view={view} onChange={setView} disabled={loading || !!bootError} />
      <div className="topbar-end">
        {runStatus && (view === 'edit' ? <button className={`run-status tone-${runStatus.tone}`} onClick={() => setResultsOpen(true)} title="查看运行结果">{runStatus.text}</button> : <span className={`run-status tone-${runStatus.tone}`}>{runStatus.text}</span>)}
        {busy ? <button className="stop-button" disabled={!!action} onClick={stop} title="停止所有运行中的用户程序"><Square size={10} fill="currentColor" />停止</button>
          : <button className="primary-button" disabled={!available || !!action} onClick={() => start()} title="开始对拍（Ctrl+Enter）">{action === 'start' ? <LoaderCircle size={13} className="spin" /> : <Play size={12} fill="currentColor" />}开始对拍</button>}
        <div className="menu-anchor" ref={menuAnchor}>
          <button className="icon-button" aria-label="更多" title="更多" aria-expanded={menu} onClick={() => setMenu(value => !value)}><MoreHorizontal size={16} /></button>
          {menu && <div className="menu menu-end" role="menu" aria-label="更多">
            <button role="menuitem" disabled={busy || !!action || loading || !!bootError} onClick={menuAction(() => setModal({ type: 'create', title: '' }))}>新建题目</button>
            <button role="menuitem" disabled={!problem || busy || !!action} onClick={menuAction(() => problem && setModal({ type: 'rename', title: problem.title }))}>重命名题目</button>
            <button role="menuitem" className="danger" disabled={!problem || busy || !!action} onClick={menuAction(() => problem && setModal({ type: 'delete', title: problem.title }))}>删除题目</button>
            <div className="menu-separator" />
            <button role="menuitem" aria-label="全屏模式" disabled={!available} onClick={menuAction(() => { void changeFullscreen(true); })}>全屏<kbd>F11</kbd></button>
            {window.duipai?.openDataDirectory && <button role="menuitem" onClick={menuAction(() => { void window.duipai!.openDataDirectory!().catch(error => showError(message(error))); })}>打开数据目录</button>}
            {window.duipai?.openBackendLog && <button role="menuitem" aria-label="查看后台日志" title="打开 backend.log，查看 AI 请求阶段、耗时及错误" onClick={menuAction(() => { void window.duipai!.openBackendLog!().catch(error => showError(message(error))); })}>后台日志</button>}
            <button role="menuitem" aria-label="使用帮助" onClick={menuAction(() => setHelp(true))}>快捷键与帮助</button>
            <div className="menu-separator" />
            <div className="menu-note" title={health?.dataDir}>{bootError ? '本地服务未连接' : '本地服务已连接'}{health && ` · JDK ${health.javaVersion}`}</div>
          </div>}
        </div>
      </div>
    </header>
    {view === 'duipai' && !fullscreen && <div className="run-config" aria-label="运行配置">
      {numberField('轮数', '最大轮数', 'rounds')}
      <label className="config-field seed-field"><span>种子</span><input value={problem?.settings.startSeed ?? ''} inputMode="numeric" placeholder="随机" disabled={configDisabled} onChange={event => setting('startSeed', event.target.value || null)} aria-label="起始种子" /></label>
      {numberField('并行', '并行度', 'parallelism')}
      <span className="config-separator" />
      <span className="config-caption">时限 ms</span>
      {numberField('生成器', '生成器时限', 'generatorTimeoutMs')}
      {numberField('暴力解', '暴力解时限', 'bruteTimeoutMs')}
      {numberField('优化解', '优化解时限', 'optimizedTimeoutMs')}
    </div>}
    <main className="main-workspace"><Split sizes={layout.sidebar} onChange={sizes => changeLayout('sidebar', sizes)} label="题目列表宽度" activePane={sidebarOpen && !fullscreen ? undefined : 1}>
      <aside className="sidebar">
        <div className="sidebar-heading"><strong>题目<span>{summaries.length}</span></strong><button className="icon-button" title="新建题目" aria-label="新建题目" disabled={busy || !!action || loading || !!bootError} onClick={() => setModal({ type: 'create', title: '' })}><Plus size={15} /></button></div>
        <label className="search-field"><Search size={13} /><input placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索题目" />{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={12} /></button>}</label>
        <div className="problem-list">{filtered.map(item => <button className={`problem-item ${problem?.id === item.id ? 'active' : ''}`} key={item.id} disabled={busy || !!action} onClick={() => switchProblem(item.id)} title={`${dateTime(item.updatedAt)} 更新`}><span>{item.title}</span><small>{dateTime(item.updatedAt)}</small></button>)}{!filtered.length && !loading && <div className="sidebar-empty">{query ? '没有匹配的题目' : '还没有题目'}</div>}</div>
      </aside>
      <div className="workbench">{loading ? <div className="workbench-message"><LoaderCircle size={16} className="spin" /><p>正在连接本地服务…</p></div>
        : bootError ? <div className="workbench-message error-state"><h2>无法连接本地服务</h2><p>{bootError}</p><button className="primary-button" onClick={() => setBootVersion(value => value + 1)}>重新连接</button></div>
        : !problem ? <div className="workbench-message"><h2>还没有题目</h2><p>新建后会自带生成器、暴力解和优化解模板。</p><button className="primary-button" onClick={() => setModal({ type: 'create', title: '' })}><Plus size={14} />新建题目</button></div>
        : <Split sizes={view === 'edit' ? layout.statementEdit : layout.statement} onChange={sizes => changeLayout(view === 'edit' ? 'statementEdit' : 'statement', sizes)} label="题面宽度"><Statement key={problem.id} fullscreen={fullscreen} title={problem.title} onExitFullscreen={() => { void changeFullscreen(false); }} problemId={problem.id} value={problem.statement} onChange={statement => edit(current => ({ ...current, statement }))} onError={showError} onUpload={registerUpload} fontSize={readingSize} /><CodeWorkspace fullscreen={fullscreen} problem={problem} job={job} history={history} historical={historical} onCodeChange={(role, value) => edit(current => ({ ...current, codes: { ...current.codes, [role]: value } }))} onReplay={seed => start(seed)} onSelectRun={selectRun} busy={busy || !!action} layout={layout} changeLayout={changeLayout} historyLoading={historyLoading} view={view} resultsOpen={resultsOpen} onToggleResults={() => setResultsOpen(value => !value)} fontSize={readingSize} /></Split>}</div>
    </Split></main>
    {toast && <div className="toast" role="alert"><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    {modal && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !action) setModal(null); }}><form className="modal problem-modal" role="dialog" aria-modal="true" aria-label={modal.type === 'create' ? '新建题目' : modal.type === 'rename' ? '重命名题目' : '确认删除题目'} onSubmit={event => { event.preventDefault(); submitModal(); }}><div className="modal-heading"><h2>{modal.type === 'create' ? '新建题目' : modal.type === 'rename' ? '重命名题目' : '删除这道题目？'}</h2><button className="icon-button" type="button" disabled={!!action} onClick={() => setModal(null)} aria-label="关闭"><X size={16} /></button></div>{modal.type === 'delete' ? <p className="delete-description">「{modal.title}」的题面、三份代码及所有运行记录都会被删除，无法撤销。</p> : <><label className="modal-label" htmlFor="problem-title">题目标题</label><input id="problem-title" className="modal-input" autoFocus maxLength={200} value={modal.title} onChange={event => setModal({ ...modal, title: event.target.value })} placeholder="例如：区间和" />{modal.type === 'create' && <p className="modal-hint">会创建生成器、暴力解与优化解模板，类名均为 Main。</p>}</>}<div className="modal-actions"><button className="small-button" type="button" disabled={!!action} onClick={() => setModal(null)}>取消</button><button className={modal.type === 'delete' ? 'danger-button' : 'primary-button'} type="submit" disabled={!!action}>{action === 'modal' && <LoaderCircle size={13} className="spin" />}{modal.type === 'delete' ? '确认删除' : modal.type === 'create' ? '创建题目' : '保存名称'}</button></div></form></div>}
    {help && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setHelp(false); }}><section className="modal help-modal" role="dialog" aria-modal="true" aria-label="使用帮助"><div className="modal-heading"><h2>快捷键与帮助</h2><button className="icon-button" onClick={() => setHelp(false)} aria-label="关闭帮助"><X size={16} /></button></div>
      <dl className="help-keys">{([['Ctrl+Enter', '开始对拍'], ['Ctrl+S', '立即保存'], ['Ctrl+Tab', '切换生成器 / 暴力解 / 优化解'], ['Alt+1', '显示或隐藏题目列表'], ['Ctrl+= / Ctrl+- / Ctrl+0', '放大 / 缩小 / 重置字号'], ['F11', '全屏，Esc 退出']] as const).map(([key, text]) => <div key={key}><dt>{text}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl>
      <ol className="help-steps"><li>题面支持 Markdown 与 LaTeX，编辑时可粘贴或拖入截图。</li><li>生成器从 args[0] 读取种子；暴力解与优化解从标准输入读取同一份数据。</li><li>开始对拍后先统一编译，再逐轮运行，遇到第一个反例即停止。</li><li>修改代码后，在运行结果中点击「用此种子复现」验证是否修复。</li></ol>
      <p className="help-note">停止输入 1 秒后自动保存；开始对拍、切换题目和关闭窗口前也会保存。</p>
      <div className="modal-actions"><button className="primary-button" onClick={() => setHelp(false)}>知道了</button></div></section></div>}
  </div>;
}
