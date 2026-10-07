import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, ChevronDown, CircleHelp, Database, FileCode2, FolderOpen, HardDrive, LoaderCircle, MoreHorizontal, Pencil, Play, Plus, Search, ShieldCheck, Square, TerminalSquare, Trash2, X } from 'lucide-react';
import { api } from './api';
import { CodeWorkspace } from './CodeWorkspace';
import { DisplayControls } from './DisplayControls';
import { dateTime } from './Results';
import { Split } from './Split';
import { Statement } from './Statement';
import { PendingUploads } from './pendingUploads';
import { advanceSnapshot } from './jobSnapshots';
import { readDisplayPreferences } from './displayPreferences';
import { useFullscreen } from './useFullscreen';
import { roles, type Health, type Job, type Layout, type Problem, type ProblemSummary, type Settings } from './types';

const defaultLayout: Layout = { sidebar: [16, 84], statement: [26, 74], workspace: [58, 42], editors: [33.333, 33.333, 33.334], outputs: [24, 76], uiMode: [0], codeTab: [0] };
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
      if (event.key === 'Escape') { setModal(null); setHelp(false); }
      if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void forceSave().catch(() => undefined); }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [forceSave]);

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
  const numberField = (label: string, key: 'rounds' | 'parallelism' | 'generatorTimeoutMs' | 'bruteTimeoutMs' | 'optimizedTimeoutMs', unit?: string) => <label className={`toolbar-field field-${key}`}><span>{label}</span><div><input type="number" min="1" step="1" value={problem?.settings[key] ?? ''} disabled={!available || busy || !!action} onChange={event => { const number = event.target.valueAsNumber; if (Number.isFinite(number)) setting(key, number); }} aria-label={label} />{unit && <small>{unit}</small>}</div></label>;
  return <div className={`app-shell ${fullscreen ? 'is-fullscreen' : ''}`}><header className="app-header"><div className="brand"><span className="brand-logo"><TerminalSquare size={22} /></span><div><strong>对拍<span>DUIPAI</span></strong><small>JAVA 本地工作台</small></div></div><div className="header-divider" /><div className="workspace-name">我的工作空间<ChevronDown size={12} /></div><div className="header-right"><DisplayControls mode={readDisplayPreferences(layout).mode} onChange={mode => changeLayout('uiMode', [mode === 'tabs' ? 1 : 0])} disabled={loading || !!bootError} fullscreenDisabled={!available} onFullscreen={() => { void changeFullscreen(true); }} /><span className="local-badge"><ShieldCheck size={12} />离线 · 本地存储</span><button className="icon-button help-button" aria-label="使用帮助" title="使用帮助" onClick={() => setHelp(true)}><CircleHelp size={18} /></button></div></header>
    <div className="toolbar"><div className="toolbar-caption"><span className={`toolbar-status ${busy ? 'busy' : ''}`} /><div><strong>{busy ? job?.state === 'COMPILING' ? '正在编译' : '正在对拍' : '运行配置'}</strong><span>{busy ? connected ? '实时更新' : '连接恢复中' : '每轮独立 Java 进程'}</span></div></div><div className="toolbar-fields">{numberField('最大轮数', 'rounds', '轮')}<label className="toolbar-field seed-field"><span>起始种子</span><div><input value={problem?.settings.startSeed ?? ''} inputMode="numeric" placeholder="随机" disabled={!available || busy || !!action} onChange={event => setting('startSeed', event.target.value || null)} aria-label="起始种子" /></div></label>{numberField('并行度', 'parallelism')}<div className="toolbar-vline" />{numberField('生成器时限', 'generatorTimeoutMs', 'ms')}{numberField('暴力解时限', 'bruteTimeoutMs', 'ms')}{numberField('优化解时限', 'optimizedTimeoutMs', 'ms')}</div><div className="toolbar-actions"><button className="primary-button" disabled={!available || busy || !!action} onClick={() => start()}>{action === 'start' ? <LoaderCircle size={14} className="spin" /> : <Play size={14} fill="currentColor" />}开始对拍</button><button className="stop-button" disabled={!busy || !!action} onClick={stop} title="停止所有运行中的用户程序"><Square size={12} fill="currentColor" />停止</button></div></div>
    <main className="main-workspace"><Split sizes={layout.sidebar} onChange={sizes => changeLayout('sidebar', sizes)} label="题目列表宽度" activePane={fullscreen ? 1 : undefined}><aside className="sidebar"><div className="sidebar-heading"><strong>题目库<span>{summaries.length}</span></strong><button className="icon-button add-button" title="新建题目" aria-label="新建题目" disabled={busy || !!action || loading || !!bootError} onClick={() => setModal({ type: 'create', title: '' })}><Plus size={17} /></button></div><label className="search-field"><Search size={14} /><input placeholder="搜索题目…" value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索题目" />{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={12} /></button>}</label><div className="problem-list">{filtered.map((item, index) => <button className={`problem-item ${problem?.id === item.id ? 'active' : ''}`} key={item.id} disabled={busy || !!action} onClick={() => switchProblem(item.id)}><span className="problem-index">{String(index + 1).padStart(2, '0')}</span><span className="problem-info"><strong>{item.title}</strong><small>{dateTime(item.updatedAt)} 更新</small></span>{problem?.id === item.id && <span className="active-indicator" />}</button>)}{!filtered.length && !loading && <div className="sidebar-empty">{query ? '没有找到匹配的题目' : '还没有题目，点击 + 新建'}</div>}</div>{problem && <div className="sidebar-problem-actions"><button className="text-button" disabled={busy || !!action} onClick={() => setModal({ type: 'rename', title: problem.title })}><Pencil size={13} />改名</button><button className="text-button delete-button" disabled={busy || !!action} onClick={() => setModal({ type: 'delete', title: problem.title })}><Trash2 size={13} />删除</button></div>}<div className="sidebar-bottom"><span className="storage-icon"><Database size={17} /></span><div><strong>所有数据保存在本机</strong><small>题面、代码与每一次运行</small></div>{window.duipai?.openDataDirectory && <button className="icon-button" title="打开数据目录" aria-label="打开数据目录" onClick={() => { void window.duipai!.openDataDirectory!().catch(error => showError(message(error))); }}><FolderOpen size={14} /></button>}</div></aside><div className="workbench">{loading ? <div className="workbench-loading"><LoaderCircle size={27} className="spin" /><h2>正在打开本地工作台</h2><p>读取题目、运行记录与布局…</p></div> : bootError ? <div className="workbench-loading error-state"><HardDrive size={30} /><h2>暂时无法连接本地服务</h2><p>{bootError}</p><button className="primary-button" onClick={() => setBootVersion(value => value + 1)}>重新连接</button></div> : !problem ? <div className="welcome"><div className="welcome-icon"><FileCode2 size={40} /></div><span className="eyebrow">从第一道题开始</span><h1>把灵感写成代码，<br />把错误留在本地。</h1><p>题面、三个 Java 编辑器、对拍结果，同屏工作。<br />新建题目会自动带上可运行的代码模板。</p><button className="primary-button large" onClick={() => setModal({ type: 'create', title: '' })}><Plus size={17} />新建第一道题目<ArrowRight size={17} /></button><div className="welcome-features"><span><Check size={14} />随机种子可复现</span><span><Check size={14} />自动保存</span><span><Check size={14} />完全离线</span></div></div> : <><div className="document-heading"><div><span className="document-icon"><FileCode2 size={14} /></span><h1>{problem.title}</h1><span className="document-label">Java / Main.java</span></div><button className={`save-indicator state-${saveState}`} onClick={() => { void forceSave().catch(() => undefined); }} title="立即保存（Ctrl+S）">{saveState === 'saving' ? <LoaderCircle size={12} className="spin" /> : saveState === 'saved' ? <Check size={12} /> : <span className="unsaved-dot" />}{saveState === 'saved' ? '已保存到本地' : saveState === 'saving' ? '正在保存…' : saveState === 'error' ? '保存失败 · 点击重试' : '等待自动保存'}</button></div><div className="workbench-content"><Split sizes={layout.statement} onChange={sizes => changeLayout('statement', sizes)} label="题面宽度"><Statement key={problem.id} fullscreen={fullscreen} title={problem.title} onExitFullscreen={() => { void changeFullscreen(false); }} problemId={problem.id} value={problem.statement} onChange={statement => edit(current => ({ ...current, statement }))} onError={showError} onUpload={registerUpload} /><CodeWorkspace fullscreen={fullscreen} problem={problem} job={job} history={history} historical={historical} onCodeChange={(role, value) => edit(current => ({ ...current, codes: { ...current.codes, [role]: value } }))} onReplay={seed => start(seed)} onSelectRun={selectRun} busy={busy || !!action} layout={layout} changeLayout={changeLayout} historyLoading={historyLoading} /></Split></div></>}</div></Split></main>
    <footer className="statusbar"><div><span className={`connection-dot ${bootError ? 'error' : ''}`} /><span>{bootError ? '本地服务未连接' : '本地服务已连接'}</span>{health && <><span className="statusbar-separator" /><span>JDK {health.javaVersion}</span></>}</div><div>{window.duipai?.openBackendLog && <><button className="text-button" aria-label="查看后台日志" title="打开 backend.log，查看 AI 请求阶段、耗时及错误" onClick={() => { void window.duipai!.openBackendLog!().catch(error => showError(message(error))); }}>后台日志</button><span className="statusbar-separator" /></>}<span>UTF-8</span><span className="statusbar-separator" /><span>拖动分隔条调整布局</span><span className="statusbar-separator" /><HardDrive size={11} /><span title={health?.dataDir}>SQLite · 本地</span></div></footer>
    {toast && <div className="toast" role="alert"><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    {modal && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !action) setModal(null); }}><form className="modal problem-modal" role="dialog" aria-modal="true" aria-label={modal.type === 'create' ? '新建题目' : modal.type === 'rename' ? '重命名题目' : '确认删除题目'} onSubmit={event => { event.preventDefault(); submitModal(); }}><div className="modal-heading"><h2>{modal.type === 'create' ? '新建题目' : modal.type === 'rename' ? '重命名题目' : '删除这道题目？'}</h2><button className="icon-button" type="button" disabled={!!action} onClick={() => setModal(null)} aria-label="关闭"><X size={18} /></button></div>{modal.type === 'delete' ? <p className="delete-description">「{modal.title}」的题面、三份代码及所有运行记录都会被删除。此操作无法撤销。</p> : <><label className="modal-label" htmlFor="problem-title">题目标题</label><input id="problem-title" className="modal-input" autoFocus maxLength={200} value={modal.title} onChange={event => setModal({ ...modal, title: event.target.value })} placeholder="例如：区间和的验证" /><p className="modal-hint">{modal.type === 'create' ? '自动创建生成器、暴力解与优化解模板，类名统一为 Main。' : '题面、代码与运行记录会继续保留。'}</p></>}<div className="modal-actions"><button className="small-button" type="button" disabled={!!action} onClick={() => setModal(null)}>取消</button><button className={modal.type === 'delete' ? 'danger-button' : 'primary-button'} type="submit" disabled={!!action}>{action === 'modal' && <LoaderCircle size={13} className="spin" />}{modal.type === 'delete' ? '确认删除' : modal.type === 'create' ? '创建题目' : '保存名称'}</button></div></form></div>}
    {help && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setHelp(false); }}><section className="modal help-modal" role="dialog" aria-modal="true" aria-label="使用帮助"><div className="modal-heading"><h2>从编写到复现</h2><button className="icon-button" onClick={() => setHelp(false)} aria-label="关闭帮助"><X size={18} /></button></div><ol className="help-steps"><li><strong>记录题面</strong><p>支持 Markdown、LaTeX 公式；编辑时可粘贴截图或拖入图片。</p></li><li><strong>编写三个 Main.java</strong><p>生成器从 args[0] 读取种子，暴力解与优化解从标准输入读取同一份数据。</p></li><li><strong>开始对拍</strong><p>先统一编译，再按轮次运行。发现第一个反例立即停止；可随时手动停止。</p></li><li><strong>检查并复现</strong><p>查看输入、输出差异、耗时和异常栈。修改当前代码后点击「用此种子复现」。</p></li></ol><div className="help-note"><ShieldCheck size={15} /><span>停止输入 1 秒后自动保存。开始、复现、切换题目与关闭窗口前会强制保存。分隔条支持拖动和方向键调整。</span></div><div className="modal-actions"><button className="primary-button" onClick={() => setHelp(false)}>开始使用</button></div></section></div>}
  </div>;
}
