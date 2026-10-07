import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, Settings2, Sparkles, X } from 'lucide-react';
import { api, type AiSettings } from './api';
import { parseAiStatement, prepareAiStatement } from './aiStatement';
import { recognizedSectionTitles, type RecognizedSection, type RecognizedSectionKind } from './statementRecognition';
import { AiRequestStatus } from './AiRequestStatus';
import { useAiRequestProgress } from './useAiRequestProgress';

export function AiStatementDialog({ statement, settingsRevision = 0, draft = false, onConfigure, onApply, onClose }: { statement: string; settingsRevision?: number; draft?: boolean; onConfigure: () => void; onApply: (sections: RecognizedSection[]) => void; onClose: () => void }) {
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
  const [sections, setSections] = useState<RecognizedSection[]>([]);
  const [included, setIncluded] = useState(new Set<string>());
  const [attempted, setAttempted] = useState(false);
  const tracking = useAiRequestProgress();
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
  async function organize() {
    if (busy || loading) return;
    const input = prepareAiStatement(source);
    if (!input.trim()) { setError('没有可整理的题面文字，请先识别图片或填写题面。'); return; }
    if (!settings?.model || !settings?.baseUrl) { setError('请先配置 API 地址和模型。'); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setSections([]); setIncluded(new Set()); setAttempted(true);
    tracking.begin(); setProgress('正在提交 AI 整理请求…');
    try {
      const result = await api.organizeStatement(input, abort.signal, update => {
        if (!mounted.current || controller.current !== abort) return;
        tracking.update(update);
        if (!('notice' in update) && update.state === 'RUNNING' && !abort.signal.aborted) setProgress(update.message || update.stage);
      });
      if (abort.signal.aborted) return;
      const parsed = parseAiStatement(result.statement);
      if (!parsed.some(section => section.content.trim())) throw new Error('AI 没有返回可用题面，请重试。');
      setSections(parsed); setIncluded(new Set(parsed.map(section => section.id)));
      setProgress(`已整理 ${parsed.length} 个区域。请核对数字、样例和数据范围后应用。`);
      tracking.record(`AI 整理完成，已解析 ${parsed.length} 个可编辑区域。`);
    } catch (reason) {
      if (!mounted.current) return;
      if (abort.signal.aborted) { setProgress('已取消 AI 整理，题面未修改。'); tracking.record('用户已取消 AI 整理；原题面未修改。'); }
      else { const message = reason instanceof Error ? reason.message : 'AI 整理失败，请重试。'; setError(message); setProgress('AI 整理失败，可查看处理记录后重试。'); tracking.record(message, 'error'); }
    } finally { if (mounted.current && controller.current === abort) { controller.current = null; setBusy(false); tracking.finish(); } }
  }
  function close() { controller.current?.abort(); onClose(); }
  function cancel() { if (!controller.current || controller.current.signal.aborted) return; setProgress('正在取消 AI 整理，停止后台请求…'); tracking.record('已请求取消，正在停止后台处理。'); controller.current.abort(); }
  const labels = recognizedSectionTitles;
  const applicable = sections.filter(section => included.has(section.id) && section.content.trim());
  return createPortal(<dialog ref={dialog} className="recognition-dialog ai-statement-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="recognition-heading"><div><h2 id={titleId}><Sparkles size={18} />AI 整理题面</h2><p>题面文字将发送到配置的 AI 服务。整理后可校对、编辑并选择要应用的区域。</p></div><button className="icon-button" aria-label="关闭 AI 整理窗口" onClick={close}><X size={19} /></button></div>
    <div className="recognition-toolbar ai-toolbar"><span>{loading ? '正在读取 AI 配置…' : settings?.model && settings?.baseUrl ? `模型：${settings.model}${settings.apiKeyConfigured ? '' : ' · 未配置 Key'}` : '请先配置 API 地址和模型'}</span><button className="small-button" disabled={busy} onClick={onConfigure}><Settings2 size={13} />AI 设置</button><button className="small-button" disabled={busy || loading || !source.trim()} onClick={() => { void organize(); }}>{busy ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{sections.length ? '重新整理' : '开始整理'}</button></div>
    {error && <div className="recognition-error" role="alert">{error}</div>}
    {attempted && <AiRequestStatus {...tracking} busy={busy} message={progress} />}
    <div className="recognition-body ai-statement-body"><div className="ai-statement-source"><label htmlFor={`${titleId}-source`}>发送给 AI 的文字</label><p>可先删去无关内容。图片、独立笔记和代码编辑器中的程序不会发送。</p><textarea id={`${titleId}-source`} aria-label="发送给 AI 的题面文字" value={source} disabled={busy} spellCheck={false} placeholder="请先填写题面或使用图片识别。" onChange={event => { setSource(event.target.value); setSections([]); setIncluded(new Set()); setError(''); setProgress(attempted ? '题面文字已修改，请重新整理。' : ''); }} /></div><div className="recognition-sections">{sections.length ? sections.map(section => <section key={section.id} className="recognition-section"><div className="recognition-section-heading"><label><input type="checkbox" aria-label={`应用${labels[section.kind]}`} checked={included.has(section.id)} disabled={busy} onChange={event => { const checked = event.target.checked; setIncluded(previous => { const next = new Set(previous); checked ? next.add(section.id) : next.delete(section.id); return next; }); }} />{labels[section.kind]}</label><select aria-label={`${labels[section.kind]}映射区域`} disabled={busy} value={section.kind} onChange={event => { const kind = event.target.value as RecognizedSectionKind; setSections(previous => previous.map(item => item.id === section.id ? { ...item, kind, title: labels[kind] } : item)); }}>{Object.entries(labels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></div><textarea aria-label={labels[section.kind]} spellCheck={false} disabled={busy} rows={section.kind === 'title' ? 2 : section.kind === 'samples' ? 10 : 5} value={section.content} onChange={event => { const content = event.target.value; setSections(previous => previous.map(item => item.id === section.id ? { ...item, content } : item)); }} /></section>) : <div className="recognition-empty"><Sparkles size={34} /><strong>{busy ? '正在整理题面…' : '整理段落、样例和数据范围'}</strong><p>点击「开始整理」后生成可编辑的结果。<br />核对完成后再应用到原题面。</p></div>}</div></div>
    <div className="recognition-footer"><span role="status">{progress || (draft ? '此步骤更新识别草稿，返回后再应用到题面。' : '原题面将在点击「应用到题面」后更新，应用后可撤销。')}</span><div><button className="small-button" disabled={busy && controller.current?.signal.aborted} onClick={() => { if (busy) cancel(); else close(); }}>{busy ? '取消整理' : '取消'}</button><button className="primary-button" disabled={busy || applicable.length === 0} onClick={() => onApply(applicable)}><Check size={14} />{draft ? '更新识别草稿' : '应用到题面'}</button></div></div>
  </dialog>, document.body);
}
