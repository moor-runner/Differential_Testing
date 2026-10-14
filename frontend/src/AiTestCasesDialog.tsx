import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, Settings2, Sparkles, X } from 'lucide-react';
import { api, type AiSettings } from './api';
import { prepareAiStatement } from './aiStatement';
import { hasInput, MAX_CUSTOM_CASES, toDrafts, type GeneratedDraft } from './aiTestCases';
import type { TestCase } from './types';
import { AiRequestStatus } from './AiRequestStatus';
import { useAiRequestProgress } from './useAiRequestProgress';

interface Props { statement: string; existing: TestCase[]; settingsRevision: number; onConfigure: () => void; onImport: (drafts: GeneratedDraft[]) => void; onClose: () => void }

/** Previews AI-designed edge cases; nothing is saved until the selected drafts are imported as custom cases. */
export function AiTestCasesDialog({ statement, existing, settingsRevision, onConfigure, onImport, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const titleId = useId();
  const [source, setSource] = useState(() => prepareAiStatement(statement));
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [drafts, setDrafts] = useState<GeneratedDraft[]>([]);
  const [included, setIncluded] = useState(new Set<string>());
  const [attempted, setAttempted] = useState(false);
  const tracking = useAiRequestProgress();
  const capacity = Math.max(0, MAX_CUSTOM_CASES - existing.length);
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current; element?.showModal();
    return () => { mounted.current = false; controller.current?.abort(); element?.close(); };
  }, []);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true);
    void api.aiSettings(abort.signal).then(value => { setSettings(value); setError(''); }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取 AI 配置。'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [settingsRevision]);
  async function generate() {
    if (busy || loading) return;
    const input = prepareAiStatement(source);
    if (!input.trim()) { setError('没有可发送的题面文字，请先填写题面。'); return; }
    if (!settings?.model || !settings?.baseUrl) { setError('请先配置 API 地址和模型。'); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setDrafts([]); setIncluded(new Set()); setAttempted(true);
    tracking.begin(); setProgress('正在提交 AI 生成请求…');
    try {
      const result = await api.generateTestCases(input, abort.signal, update => {
        if (!mounted.current || controller.current !== abort) return;
        tracking.update(update);
        if (!('notice' in update) && update.state === 'RUNNING' && !abort.signal.aborted) setProgress(update.message || update.stage);
      });
      if (abort.signal.aborted) return;
      const next = toDrafts(result.cases);
      // Inputs that are already custom cases start unchecked; import would skip them anyway.
      setDrafts(next); setIncluded(new Set(next.filter(draft => !hasInput(existing, draft.input)).slice(0, capacity).map(draft => draft.key)));
      setProgress(`已生成 ${next.length} 个用例。请核对输入格式；期望输出由 AI 推算，可修改或清空。`);
      tracking.record(`AI 生成完成，共 ${next.length} 个用例。`);
    } catch (reason) {
      if (!mounted.current) return;
      if (abort.signal.aborted) { setProgress('已取消 AI 生成，用例未修改。'); tracking.record('用户已取消 AI 生成；用例未修改。'); }
      else { const message = reason instanceof Error ? reason.message : 'AI 生成失败，请重试。'; setError(message); setProgress('AI 生成失败，可查看处理记录后重试。'); tracking.record(message, 'error'); }
    } finally { if (mounted.current && controller.current === abort) { controller.current = null; setBusy(false); tracking.finish(); } }
  }
  function close() { controller.current?.abort(); onClose(); }
  function cancel() { if (!controller.current || controller.current.signal.aborted) return; setProgress('正在取消 AI 生成，停止后台请求…'); tracking.record('已请求取消，正在停止后台处理。'); controller.current.abort(); }
  function edit(key: string, field: 'input' | 'expected', value: string) { setDrafts(previous => previous.map(draft => draft.key === key ? { ...draft, [field]: value } : draft)); }
  function toggle(key: string, checked: boolean) { setIncluded(previous => { const next = new Set(previous); checked ? next.add(key) : next.delete(key); return next; }); }
  const selected = drafts.filter(draft => included.has(draft.key) && draft.input.trim() && !hasInput(existing, draft.input));
  const over = selected.length > capacity;
  const footer = over ? `已选 ${selected.length} 个，超过剩余容量 ${capacity} 个（自定义用例最多 50 个），请取消勾选一些。`
    : capacity === 0 ? '自定义用例已达 50 个上限，请先删除一些再导入。'
    : progress || '导入后在「对比」模式下运行：优化解须与暴力解一致，填写了期望输出的用例同时检查暴力解。';
  return createPortal(<dialog ref={dialog} className="recognition-dialog ai-statement-dialog ai-cases-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="recognition-heading"><div><h2 id={titleId}><Sparkles size={18} />AI 生成测试用例</h2><p>题面文字将发送到配置的 AI 服务，代码不会发送。AI 设计小规模的边界和易错输入，用于检验暴力解。</p></div><button className="icon-button" aria-label="关闭 AI 生成窗口" onClick={close}><X size={19} /></button></div>
    <div className="recognition-toolbar ai-toolbar"><span>{loading ? '正在读取 AI 配置…' : settings?.model && settings?.baseUrl ? `模型：${settings.model}${settings.apiKeyConfigured ? '' : ' · 未配置 Key'}` : '请先配置 API 地址和模型'}</span><button className="small-button" disabled={busy} onClick={onConfigure}><Settings2 size={13} />AI 设置</button><button className="small-button" disabled={busy || loading || !source.trim()} onClick={() => { void generate(); }}>{busy ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{drafts.length ? '重新生成' : '开始生成'}</button></div>
    {error && <div className="recognition-error" role="alert">{error}</div>}
    {attempted && <AiRequestStatus {...tracking} busy={busy} message={progress} />}
    <div className="recognition-body ai-statement-body"><div className="ai-statement-source"><label htmlFor={`${titleId}-source`}>发送给 AI 的文字</label><p>需要包含输入格式和数据范围。图片、独立笔记和三个编辑器中的程序不会发送。</p><textarea id={`${titleId}-source`} aria-label="发送给 AI 的题面文字" value={source} disabled={busy} spellCheck={false} placeholder="请先填写题面。" onChange={event => { setSource(event.target.value); setError(''); }} /></div>
      <div className="recognition-sections">{drafts.length ? drafts.map((draft, index) => <section key={draft.key} className="recognition-section ai-case">
        <div className="recognition-section-heading"><label><input type="checkbox" aria-label={`导入用例 ${index + 1}`} checked={included.has(draft.key)} disabled={busy} onChange={event => toggle(draft.key, event.target.checked)} />用例 {index + 1}<span className="ai-case-tag">{draft.category}</span>{hasInput(existing, draft.input) && <span className="ai-case-tag duplicate">已有相同输入</span>}</label>{draft.note && <span className="ai-case-note" title={draft.note}>{draft.note}</span>}</div>
        <div className="ai-case-fields">
          <label><span>输入</span><textarea aria-label={`用例 ${index + 1} 输入`} spellCheck={false} wrap="off" disabled={busy} rows={Math.min(8, Math.max(3, draft.input.split('\n').length))} value={draft.input} onChange={event => edit(draft.key, 'input', event.target.value)} /></label>
          <label><span>期望输出{draft.expected.trim() ? <em>AI 推算，待核对</em> : <em>未给出</em>}</span><textarea aria-label={`用例 ${index + 1} 期望输出`} spellCheck={false} wrap="off" disabled={busy} rows={Math.min(8, Math.max(3, draft.expected.split('\n').length))} placeholder="留空则只比较暴力解与优化解" value={draft.expected} onChange={event => edit(draft.key, 'expected', event.target.value)} /></label>
        </div>
      </section>) : <div className="recognition-empty"><Sparkles size={34} /><strong>{busy ? '正在设计测试用例…' : '设计边界与易错用例'}</strong><p>覆盖最小规模、取值上下界、全部相同、溢出等情形。<br />AI 能手算时才给出期望输出，导入前请先核对。</p></div>}</div></div>
    <div className="recognition-footer"><span role="status" className={over ? 'error-text' : undefined}>{footer}</span><div><button className="small-button" disabled={busy && controller.current?.signal.aborted} onClick={() => { if (busy) cancel(); else close(); }}>{busy ? '取消生成' : '取消'}</button><button className="primary-button" disabled={busy || !selected.length || over} onClick={() => onImport(selected)}><Check size={14} />{selected.length ? `导入 ${selected.length} 个用例` : '导入用例'}</button></div></div>
  </dialog>, document.body);
}
