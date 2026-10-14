import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bug, Check, ChevronDown, Circle, CopyPlus, LoaderCircle, Minus, Play, Plus, Sparkles, Square, Trash2, X } from 'lucide-react';
import { formatTime } from './Results';
import { Split } from './Split';
import { bounded } from './output';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AiTestCasesDialog } from './AiTestCasesDialog';
import { importGeneratedCases, MAX_CUSTOM_CASES, type GeneratedDraft } from './aiTestCases';
import { freshRecord, type TestCasesState, type TestEntry, type TestRecord } from './useTestCases';
import { roleLabels, type DebugRole, type Layout, type ProcessResult, type TestCaseResult, type TestRole, type TestRun, type TestVerdict } from './types';

const verdictLabels: Record<TestVerdict, string> = { PASS: '通过', WA: '答案错误', RE: '运行错误', TLE: '超时', OLE: '输出超限', UNCHECKED: '未比对', BRUTE_WA: '暴力解与期望不符', BRUTE_ERROR: '暴力解出错' };
const shortVerdicts: Partial<Record<TestVerdict, string>> = { BRUTE_WA: '暴力不符', BRUTE_ERROR: '暴力出错' };
const failed = (verdict?: TestVerdict) => !!verdict && verdict !== 'PASS' && verdict !== 'UNCHECKED';
const testRoles: TestRole[] = ['optimized', 'brute', 'compare'];
const testRoleLabels: Record<TestRole, string> = { optimized: roleLabels.optimized, brute: roleLabels.brute, compare: '对比' };
const testRoleTitles: Record<TestRole, string> = {
  optimized: '用优化解运行测试用例', brute: '用暴力解运行测试用例',
  compare: '同时运行暴力解和优化解：优化解须与暴力解一致，填写了期望输出时同时检查暴力解',
};

/** Counts only results of the selected solver that still match the current case contents. */
export function testSummary(tests: TestCasesState, role: TestRole) {
  const { entries } = tests, outcome = tests.outcome?.role === role ? tests.outcome : null;
  if (tests.running) return { tone: 'active', text: tests.running.cancelled ? '正在停止…' : '运行中…' };
  if (!outcome) return null;
  if (outcome.run.verdict === 'CE') return { tone: 'fail', text: '编译错误' };
  const results = entries.map(entry => freshRecord(outcome, entry)?.result).filter(result => !!result);
  if (!results.length) return outcome.run.verdict === 'CANCELLED' ? { tone: 'muted', text: '已停止' } : null;
  const passed = results.filter(result => result.verdict === 'PASS').length, failures = results.filter(result => failed(result.verdict)).length;
  return { tone: failures ? 'fail' : passed === results.length ? 'pass' : 'muted', text: `${passed} / ${results.length} 通过` };
}

function StatusIcon({ record, running, ce }: { record?: TestRecord; running: boolean; ce: boolean }) {
  if (running) return <LoaderCircle size={12} className="spin test-status active" aria-label="运行中" />;
  const verdict = record?.result?.verdict;
  if (ce && record) return <X size={12} className="test-status fail" aria-label="编译错误" />;
  if (!verdict) return <Circle size={9} className="test-status idle" aria-label="未运行" />;
  if (verdict === 'PASS') return <Check size={12} className="test-status pass" aria-label="通过" />;
  if (verdict === 'UNCHECKED') return <Minus size={12} className="test-status muted" aria-label="未比对" />;
  return <X size={12} className="test-status fail" aria-label={verdictLabels[verdict]} />;
}

function OutputView({ text, line }: { text: string; line?: number }) {
  const host = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => text.replace(/\r\n/g, '\n').split('\n'), [text]);
  // Highlighting splits every line into a node, so very long outputs only get the message above.
  const marked = line && lines.length <= 5000 ? line : undefined;
  useLayoutEffect(() => { host.current?.querySelector('.diff-line')?.scrollIntoView({ block: 'center' }); }, [text, marked]);
  if (!text) return <pre className="test-output"><span className="muted">（空）</span></pre>;
  return <pre className="test-output" ref={host}>{marked ? lines.map((value, index) => <span key={index} className={index + 1 === marked ? 'diff-line' : undefined}>{value}{index < lines.length - 1 ? '\n' : ''}</span>) : text}{marked && marked > lines.length && <span className="diff-line missing">{'\n'}（缺少第 {marked} 行）</span>}</pre>;
}

/** One program's stdout with the differing line marked, followed by its stderr. */
function OutputField({ label, process, badge, line, waiting }: { label: string; process?: ProcessResult; badge?: string; line?: number; waiting: string }) {
  const stdout = useMemo(() => bounded(process?.stdout), [process?.stdout]);
  const stderr = useMemo(() => bounded(process?.stderr), [process?.stderr]);
  return <div className="test-field"><span>{label}{process && <b>{badge ? `${badge} · ` : ''}{formatTime(process.elapsedMs)}</b>}</span>
    {process ? <><OutputView text={stdout.text} line={line} />{stdout.truncated && <div className="truncate-note">输出超过 1 MiB，仅显示前 1 MiB。</div>}{process.stderr && <><span className="test-stderr-title">stderr</span><pre className="test-output test-stderr">{stderr.text}</pre></>}</>
      : <pre className="test-output"><span className="muted">{waiting}</span></pre>}
  </div>;
}

function show(value: string | null | undefined) { return value === null || value === undefined ? '（无此行）' : value === '' ? '（空行）' : value.length > 60 ? `${value.slice(0, 60)}…` : value; }
function processFailure(process: ProcessResult) { return process.outputLimited ? '输出超限' : process.timedOut ? '超时' : process.exitCode !== 0 ? '运行错误' : undefined; }

/** In compare mode the top-level process is optimized and `brute` is present. */
function resultMessage(result: TestCaseResult, run: TestRun, hasExpected: boolean, ai: boolean) {
  const { brute } = result, compare = !!brute, solver = compare ? '优化解' : '';
  // AI inputs that break the input format usually surface as a runtime error.
  const formatHint = ai ? '；AI 生成的输入也可能不符合题目格式' : '';
  const difference = result.firstDifference, expected = result.expectedDifference;
  switch (result.verdict) {
    case 'PASS': return brute ? `${hasExpected ? '暴力解与期望一致，' : ''}优化解与暴力解一致 · 暴力 ${formatTime(brute.elapsedMs)} / 优化 ${formatTime(result.elapsedMs)}` : `输出与期望一致 · ${formatTime(result.elapsedMs)}`;
    case 'WA': return !difference ? '输出不一致' : compare ? `第 ${difference.line} 行不同：暴力解 ${show(difference.expected)}，优化解 ${show(difference.actual)}` : `第 ${difference.line} 行不同：期望 ${show(difference.expected)}，实际 ${show(difference.actual)}`;
    case 'BRUTE_WA': return `暴力解与期望输出${expected ? `第 ${expected.line} 行不同：期望 ${show(expected.expected)}，暴力解 ${show(expected.actual)}` : '不一致'}${ai ? '。期望由 AI 推算，请先人工核对' : ''}`;
    case 'BRUTE_ERROR': return !brute ? '暴力解出错' : brute.outputLimited ? '暴力解输出超过 8 MiB 上限，已终止' : brute.timedOut ? `暴力解超过 ${run.bruteTimeoutMs ?? ''} ms 时限，已终止` : `暴力解异常退出（退出码 ${brute.exitCode ?? '—'}），见暴力解 stderr${formatHint}`;
    case 'TLE': return `${solver}超过 ${run.timeoutMs ?? ''} ms 时限，已终止`;
    case 'RE': return `${solver}异常退出（退出码 ${result.exitCode ?? '—'}），见${compare ? '优化解' : '下方'} stderr${formatHint}`;
    case 'OLE': return `${solver}输出超过 8 MiB 上限，已终止`;
    default: return `没有期望输出，仅运行 · ${formatTime(result.elapsedMs)}`;
  }
}

interface Props {
  tests: TestCasesState; role: TestRole; onRoleChange: (role: TestRole) => void; busy: boolean; switcher: ReactNode; onClose?: () => void; layout: Layout; setLayout: (id: string, sizes: number[]) => void; visible: boolean;
  onDebug: (role: DebugRole, entry: TestEntry) => void; debugStarting: boolean; onSelectionChange: (key: string | null) => void;
}

export function TestCases({ tests, role, onRoleChange, busy, switcher, onClose, layout, setLayout, visible, onDebug, debugStarting, onSelectionChange }: Props) {
  const { entries, custom, status, running } = tests;
  // Results of the other solver stay in memory but are not shown as if they belonged to this one.
  const outcome = tests.outcome?.role === role ? tests.outcome : null;
  const [selected, setSelected] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiSettingsRevision, setAiSettingsRevision] = useState(0);
  const [debugMenu, setDebugMenu] = useState(false);
  const debugAnchor = useRef<HTMLDivElement>(null);
  const entry = entries.find(item => item.key === selected) ?? entries[0];
  useEffect(() => { onSelectionChange(entry?.key ?? null); }, [entry?.key]);
  useEffect(() => {
    if (!debugMenu) return;
    const closeOutside = (event: PointerEvent) => { if (!debugAnchor.current?.contains(event.target as Node)) setDebugMenu(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [debugMenu]);
  const ce = outcome?.run.verdict === 'CE';
  const summary = testSummary(tests, role);
  const runDisabled = busy || !!running || !entries.length;
  const full = custom.length >= MAX_CUSTOM_CASES;
  const compare = role === 'compare';
  // After a run, show the first case that failed.
  useEffect(() => {
    if (!outcome) return;
    const failing = entries.find(item => failed(freshRecord(outcome, item)?.result?.verdict));
    if (failing) setSelected(failing.key);
  }, [outcome?.run.id]);

  function add(source?: TestEntry) {
    const id = crypto.randomUUID();
    tests.updateCustom([...custom, { id, input: source?.input ?? '', expected: source?.expected ?? '' }]);
    setSelected(id);
  }
  function remove(key: string) {
    const index = custom.findIndex(test => test.id === key);
    const next = custom.filter(test => test.id !== key);
    tests.updateCustom(next);
    setSelected(next[Math.min(index, next.length - 1)]?.id ?? null);
  }
  function edit(key: string, field: 'input' | 'expected', value: string) { tests.updateCustom(custom.map(test => test.id === key ? { ...test, [field]: value } : test)); }
  // AI cases are meant to check brute against optimized, so importing switches to compare mode.
  function importAi(drafts: GeneratedDraft[]) {
    const { cases, added } = importGeneratedCases(custom, drafts, () => crypto.randomUUID());
    setAiOpen(false);
    if (!added.length) return;
    tests.updateCustom(cases);
    setSelected(added[0].id);
    if (!running) onRoleChange('compare');
  }

  const samples = entries.filter(item => item.source === 'sample'), customs = entries.filter(item => item.source === 'custom');
  const item = (value: TestEntry) => {
    const record = freshRecord(outcome, value), result = record?.result;
    return <button key={value.key} type="button" className={`test-item ${entry?.key === value.key ? 'active' : ''}`} onClick={() => setSelected(value.key)} aria-current={entry?.key === value.key}>
      <StatusIcon record={record} running={!!running?.keys.includes(value.key)} ce={ce} /><span>{value.label}{value.ai && <em className="test-ai-badge" title={value.ai.note || 'AI 生成的用例'}>AI</em>}</span>
      <small className={failed(result?.verdict) || (ce && record) ? 'error-text' : undefined}>{ce && record ? 'CE' : result ? (result.verdict === 'PASS' ? formatTime(result.elapsedMs) : result.verdict === 'UNCHECKED' ? '未比对' : shortVerdicts[result.verdict] ?? result.verdict) : record ? '已停止' : outcome?.records[value.key] ? '已修改' : ''}</small>
    </button>;
  };

  const record = entry ? freshRecord(outcome, entry) : undefined;
  const result = record?.result ?? null;
  const editable = entry?.source === 'custom' && status === 'ready';
  const entryRunning = !!entry && !!running?.keys.includes(entry.key);
  const detailMessage = !entry ? '' : entryRunning ? (running?.cancelled ? '正在停止…' : '正在编译并运行…')
    : !record ? (outcome?.records[entry.key] ? '用例在运行后被修改，请重新运行。' : '尚未运行。')
    : ce ? '编译失败，尚未运行。'
    : !result ? '已停止，此用例未运行。'
    : resultMessage(result, outcome!.run, !!record.expected.trim(), !!entry.ai);
  const waiting = entryRunning ? '运行中…' : '运行后显示';
  const aiButtonTitle = full ? `自定义用例已达 ${MAX_CUSTOM_CASES} 个上限` : 'AI 读取题面，生成边界和易错用例';

  return <section className="panel result-panel test-panel">
    <div className="panel-heading result-heading">
      <div className="panel-title">{switcher}{summary && <span className={`verdict ${summary.tone === 'fail' ? 'fail' : summary.tone === 'active' ? 'running' : summary.tone === 'pass' ? 'pass' : 'cancelled'}`}>{summary.tone === 'active' && <span className="status-pulse" />}{summary.text}</span>}</div>
      <div className="result-actions">
        <div className="segmented test-role" role="group" aria-label="运行的程序">{testRoles.map(value => <button key={value} type="button" className={role === value ? 'selected' : ''} aria-pressed={role === value} disabled={!!running} onClick={() => onRoleChange(value)} title={testRoleTitles[value]}>{testRoleLabels[value]}</button>)}</div>
        {running ? <button type="button" className="stop-button" disabled={running.cancelled} onClick={tests.cancel} title="停止运行中的测试用例"><Square size={10} fill="currentColor" />停止</button>
          : <button type="button" className="small-button" disabled={runDisabled} onClick={() => { void tests.run(role); }} title={busy ? '对拍运行中' : '保存代码并运行全部用例（Ctrl+Shift+Enter）'}><Play size={11} fill="currentColor" />运行全部{entries.length > 0 && <span className="muted">{entries.length}</span>}</button>}
        {onClose && <button className="icon-button" onClick={onClose} title="收起运行结果" aria-label="收起运行结果"><ChevronDown size={15} /></button>}
      </div>
    </div>
    <div className="result-content"><Split sizes={layout.tests || [22, 78]} onChange={value => setLayout('tests', value)} label="测试用例列表宽度" visible={visible}>
      <nav className="test-list" aria-label="测试用例">
        <div className="test-group-title">题面样例<span>{samples.length}</span></div>
        {samples.map(item)}
        {!samples.length && <p className="test-hint">题面中没有识别到样例。把样例放在「样例」标题下的代码块中，或添加自定义用例。</p>}
        <div className="test-group-title">自定义<span>{customs.length}</span><button type="button" className="icon-button test-ai-button" title={aiButtonTitle} aria-label="AI 生成测试用例" disabled={status !== 'ready' || full} onClick={() => setAiOpen(true)}><Sparkles size={13} /></button><button type="button" className="icon-button" title="添加测试用例" aria-label="添加测试用例" disabled={status !== 'ready'} onClick={() => add()}><Plus size={13} /></button></div>
        {customs.map(item)}
        {status === 'loading' && <p className="test-hint">正在读取…</p>}
        {status === 'failed' && <p className="test-hint error-text">读取失败。<button type="button" className="text-button" onClick={tests.reload}>重试</button></p>}
        {status === 'ready' && !customs.length && <><button type="button" className="test-add" onClick={() => add()}><Plus size={12} />添加用例</button><button type="button" className="test-add" onClick={() => setAiOpen(true)} title={aiButtonTitle}><Sparkles size={12} />AI 生成用例</button></>}
      </nav>
      {!entry ? <div className="empty-state"><h3>还没有测试用例</h3><p>题面中「样例」下的输入与输出代码块会自动成为用例；<br />也可以添加自定义用例，或让 AI 读取题面生成边界用例。</p><div className="empty-actions"><button type="button" className="small-button" disabled={status !== 'ready'} onClick={() => add()}><Plus size={12} />添加用例</button><button type="button" className="small-button" disabled={status !== 'ready'} onClick={() => setAiOpen(true)}><Sparkles size={12} />AI 生成用例</button></div></div>
        : <div className="test-detail">
          <div className={`result-message ${failed(result?.verdict) || (ce && record) ? 'warning' : ''}`}><span title={detailMessage}><strong className="test-detail-title">{entry.label}</strong>{detailMessage}</span>
            <div className="test-detail-actions">
              <button type="button" className="text-button" disabled={runDisabled} onClick={() => { void tests.run(role, [entry.key]); }} title={compare ? '只对比运行这个用例' : `用${roleLabels[role as 'brute' | 'optimized']}只运行这个用例`}><Play size={11} />运行</button>
              {compare ? <div className="menu-anchor" ref={debugAnchor}>
                <button type="button" className="text-button" disabled={debugStarting} aria-expanded={debugMenu} onClick={() => setDebugMenu(value => !value)} title="在编辑器中断点调试这个用例"><Bug size={12} />调试<ChevronDown size={11} /></button>
                {debugMenu && <div className="menu menu-end" role="menu" aria-label="调试的程序">{(['optimized', 'brute'] as const).map(value => <button key={value} type="button" role="menuitem" onClick={() => { setDebugMenu(false); onDebug(value, entry); }}>调试{roleLabels[value]}</button>)}</div>}
              </div>
                : <button type="button" className="text-button" disabled={debugStarting} onClick={() => onDebug(role as DebugRole, entry)} title={`用${roleLabels[role as DebugRole]}在编辑器中断点调试这个用例（Shift+F9）`}><Bug size={12} />调试</button>}
              {entry.source === 'sample' ? <button type="button" className="text-button" disabled={status !== 'ready'} onClick={() => add(entry)} title="复制为可编辑的自定义用例"><CopyPlus size={12} />复制为自定义</button>
                : <button type="button" className="text-button" disabled={status !== 'ready'} onClick={() => remove(entry.key)} title="删除这个自定义用例" aria-label={`删除${entry.label}`}><Trash2 size={12} />删除</button>}
            </div>
          </div>
          {entry.ai && <div className="test-ai-note"><Sparkles size={11} /><span>AI 生成{entry.ai.category ? ` · ${entry.ai.category}` : ''}</span>{entry.ai.note && <span title={entry.ai.note}>{entry.ai.note}</span>}</div>}
          {ce && record ? <div className="compile-errors">{outcome!.run.compileErrors.map((error, index) => <div className="compile-error" key={index}><div className="error-section-title">{roleLabels[error.role]}编译失败</div><pre>{bounded(error.output).text}</pre></div>)}</div>
            : <div className={`test-columns ${compare ? 'compare' : ''}`}>
              <label className="test-field"><span>输入 · stdin</span><textarea value={entry.input} readOnly={!editable} spellCheck={false} wrap="off" placeholder={editable ? '程序从标准输入读取的内容' : ''} aria-label={`${entry.label}输入`} onChange={event => edit(entry.key, 'input', event.target.value)} /></label>
              <label className="test-field"><span>期望输出{!entry.expected.trim() ? <em>{compare ? '留空则只对比两个程序' : '留空则不比对'}</em> : entry.ai && <em className="ai-unverified">AI 推算，待核对</em>}</span><textarea value={entry.expected} readOnly={!editable} spellCheck={false} wrap="off" placeholder={editable ? (compare ? '留空则只比较暴力解与优化解' : '留空则只运行、不比对') : '（题面未给出输出）'} aria-label={`${entry.label}期望输出`} onChange={event => edit(entry.key, 'expected', event.target.value)} /></label>
              {compare ? <>
                <OutputField label="暴力解输出" process={result?.brute} badge={result?.brute && processFailure(result.brute)} line={result?.verdict === 'BRUTE_WA' ? result.expectedDifference?.line : undefined} waiting={waiting} />
                <OutputField label="优化解输出" process={result ?? undefined} badge={result ? processFailure(result) : undefined} line={result?.verdict === 'WA' ? result.firstDifference?.line : undefined} waiting={waiting} />
              </> : <OutputField label="实际输出" process={result ?? undefined} badge={result ? verdictLabels[result.verdict] : undefined} line={result?.verdict === 'WA' ? result.firstDifference?.line : undefined} waiting={waiting} />}
            </div>}
          {entry.source === 'sample' && <div className="diff-footer">题面样例只读：修改题面，或复制为自定义用例后编辑 · 逐行比对，忽略行尾空白与末尾空行</div>}
        </div>}
    </Split></div>
    {aiOpen && <AiTestCasesDialog statement={tests.statement} existing={custom} settingsRevision={aiSettingsRevision} onConfigure={() => setAiSettingsOpen(true)} onImport={importAi} onClose={() => setAiOpen(false)} />}
    {aiSettingsOpen && <AiSettingsDialog onClose={() => setAiSettingsOpen(false)} onSaved={() => setAiSettingsRevision(revision => revision + 1)} />}
  </section>;
}
