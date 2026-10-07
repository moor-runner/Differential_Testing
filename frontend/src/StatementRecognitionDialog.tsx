import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, ScanText, Sparkles, X } from 'lucide-react';
import { api, type RecognitionStatus } from './api';
import { mergeRecognizedStatement, parseRecognizedStatement, recognizedSectionTitles, type OcrImage, type RecognizedSection, type RecognizedSectionKind } from './statementRecognition';
import { AiStatementDialog } from './AiStatementDialog';
import type { StatementImageSource } from './statementImages';
import { prepareRecognitionImage, refineRecognitionImage } from './recognitionCleanup';

const labels = recognizedSectionTitles;

export function StatementRecognitionDialog({ sources, onApply, onClose, autoStart = false, aiSettingsRevision = 0, onAiConfigure }: { sources: StatementImageSource[]; onApply: (sections: RecognizedSection[]) => void; onClose: () => void; autoStart?: boolean; aiSettingsRevision?: number; onAiConfigure: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const titleId = useId();
  const [status, setStatus] = useState<RecognitionStatus | null>(null);
  const [selected, setSelected] = useState(() => new Set(sources.map(source => source.url)));
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [images, setImages] = useState<OcrImage[]>([]);
  const [sections, setSections] = useState<RecognizedSection[]>([]);
  const [included, setIncluded] = useState(new Set<string>());
  const [activeSection, setActiveSection] = useState('');
  const [imageIndex, setImageIndex] = useState(0);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [aiOrganizing, setAiOrganizing] = useState(false);
  const [processingNotes, setProcessingNotes] = useState<string[]>([]);
  const started = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const abort = new AbortController();
    void api.recognitionStatus(abort.signal).then(setStatus).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取识别状态。'); }).finally(() => { if (!abort.signal.aborted) setLoadingStatus(false); });
    return () => { abort.abort(); controller.current?.abort(); element?.close(); };
  }, []);
  useEffect(() => {
    if (autoStart && !loadingStatus && status?.available && !started.current) {
      started.current = true; void recognize();
    }
  }, [autoStart, loadingStatus, status]);

  async function recognize() {
    if (busy) return;
    const chosen = sources.filter(source => selected.has(source.url));
    if (!chosen.length) { setError('请至少选择一张图片。'); return; }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError(''); setProcessingNotes([]);
    try {
      const results: OcrImage[] = [];
      for (let index = 0; index < chosen.length; index++) {
        setProgress(`正在识别第 ${index + 1} / ${chosen.length} 张图片…`);
        const primary = await api.recognizeImage(chosen[index].url, language, abort.signal);
        const prepared = prepareRecognitionImage(primary);
        let result = primary;
        if (prepared.region) {
          setProgress(`正在清理第 ${index + 1} / ${chosen.length} 张图片的题目栏…`);
          try {
            const focused = await api.recognizeImage(chosen[index].url, primary.language || language, abort.signal, prepared.region);
            if (focused.lines.length) result = refineRecognitionImage(primary, focused);
          } catch (reason) {
            if (abort.signal.aborted) throw reason;
            const detail = reason instanceof Error ? reason.message : '增强识别不可用';
            setProcessingNotes(previous => [...previous, `第 ${index + 1} 张图片的题目栏增强识别失败，已保留第一次识别结果：${detail}`]);
          }
        }
        results.push(result);
        if (abort.signal.aborted) return;
      }
      const mapped = parseRecognizedStatement(results);
      if (!mapped.some(section => section.content.trim())) throw new Error('没有识别出文字，请使用清晰截图，并检查所选识别语言。');
      setImages(results); setSections(mapped); setIncluded(new Set(mapped.map(section => section.id)));
      setActiveSection(mapped[0]?.id || ''); setImageIndex(0);
      setProgress(`已识别 ${chosen.length} 张图片，映射到 ${mapped.length} 个文字区域。`);
    } catch (reason) {
      if (abort.signal.aborted) setProgress('已取消识别，题面未修改。');
      else { setError(reason instanceof Error ? reason.message : '识别失败，请重试。'); setProgress('识别失败，题面未修改。请检查错误后重试。'); }
    } finally {
      if (controller.current === abort) { controller.current = null; setBusy(false); }
    }
  }
  function close() { controller.current?.abort(); onClose(); }
  function focusSection(section: RecognizedSection) {
    setActiveSection(section.id);
    if (section.regions.length && !section.regions.some(region => region.imageIndex === imageIndex)) setImageIndex(section.regions[0].imageIndex);
  }
  const visibleImage = images[imageIndex];
  const applicable = sections.filter(section => included.has(section.id) && section.content.trim());
  return createPortal(<dialog ref={dialog} className="recognition-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="recognition-heading"><div><h2 id={titleId}><ScanText size={18} />识别图片题目</h2><p>自动排除考试界面和代码栏，整理段落与样例。校对文字和数字后应用。</p></div><button className="icon-button" aria-label="关闭识别窗口" onClick={close}><X size={19} /></button></div>
    <div className="recognition-toolbar"><label>识别语言<select aria-label="识别语言" value={language} disabled={busy || loadingStatus} onChange={event => setLanguage(event.target.value)}><option value="">自动选择</option>{status?.languages.map(item => <option key={item.tag} value={item.tag}>{item.name}</option>)}</select></label><span>{loadingStatus ? '正在检查本机识别语言…' : status?.message || 'Windows 本地文字识别'}</span><button className="small-button" disabled={busy || loadingStatus || status?.available === false || selected.size === 0} onClick={() => { void recognize(); }}>{busy ? <LoaderCircle size={13} className="spin" /> : <ScanText size={13} />}{sections.length ? '重新识别' : '开始识别'}</button></div>
    {error && <div className="recognition-error" role="alert">{error}</div>}
    {processingNotes.length > 0 && <details className="recognition-processing-notes"><summary>处理提示（{processingNotes.length}）</summary><ul>{processingNotes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
    <div className="recognition-body">
      <div className="recognition-source"><div className="recognition-source-list" aria-label="待识别图片">{sources.map((source, index) => <label key={source.url} title={source.alt}><input type="checkbox" aria-label={`选择图片 ${index + 1}`} checked={selected.has(source.url)} disabled={busy} onChange={event => { const checked = event.target.checked; setSelected(previous => { const next = new Set(previous); checked ? next.add(source.url) : next.delete(source.url); return next; }); }} /><span>{index + 1}. {source.alt}</span></label>)}</div>
        {images.length > 1 && <div className="recognition-image-tabs">{images.map((image, index) => <button key={image.url} className={imageIndex === index ? 'selected' : ''} onClick={() => setImageIndex(index)}>图片 {index + 1}</button>)}</div>}
        <div className="recognition-image-stage">{visibleImage ? <div className="recognition-image-wrap"><img src={visibleImage.url} alt="识别区域原图" />{sections.flatMap(section => section.regions.filter(region => region.imageIndex === imageIndex).map((region, index) => <button key={`${section.id}-${index}`} className={`recognition-region kind-${section.kind} ${activeSection === section.id ? 'active' : ''} ${included.has(section.id) ? '' : 'excluded'}`} aria-label={`查看${labels[section.kind]}对应原图区域`} title={labels[section.kind]} style={{ left: `${region.x / visibleImage.width * 100}%`, top: `${region.y / visibleImage.height * 100}%`, width: `${region.width / visibleImage.width * 100}%`, height: `${region.height / visibleImage.height * 100}%` }} onClick={() => { focusSection(section); document.getElementById(`${titleId}-${section.id}`)?.focus(); }}><span>{labels[section.kind]}</span></button>))}</div> : <div className="recognition-image-wrap"><img src={sources.find(source => selected.has(source.url))?.url || sources[0]?.url} alt="待识别题目截图" /></div>}</div>
        <p className="recognition-source-hint">{images.length ? '点击彩色区域查看对应文字。多张截图按选择列表顺序拼接。' : '选择需要识别的截图，然后点击「开始识别」。'}</p>
      </div>
      <div className="recognition-sections">{sections.length ? sections.map(section => <section key={section.id} className={`recognition-section ${activeSection === section.id ? 'active' : ''}`} onFocus={() => focusSection(section)}><div className="recognition-section-heading"><label><input type="checkbox" aria-label={`应用${labels[section.kind]}`} checked={included.has(section.id)} disabled={busy} onChange={event => { const checked = event.target.checked; setIncluded(previous => { const next = new Set(previous); checked ? next.add(section.id) : next.delete(section.id); return next; }); }} />{labels[section.kind]}</label><select aria-label={`${labels[section.kind]}映射区域`} value={section.kind} disabled={busy} onChange={event => { const kind = event.target.value as RecognizedSectionKind; setSections(previous => previous.map(item => item.id === section.id ? { ...item, kind, title: labels[kind] } : item)); }}>{Object.entries(labels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></div><textarea id={`${titleId}-${section.id}`} aria-label={labels[section.kind]} value={section.content} spellCheck={false} disabled={busy} rows={section.kind === 'title' ? 2 : section.kind === 'samples' ? 10 : 5} onChange={event => { const content = event.target.value; setSections(previous => previous.map(item => item.id === section.id ? { ...item, content } : item)); }} /></section>) : <div className="recognition-empty"><ScanText size={34} /><strong>{busy ? progress : '把图片转换为可编辑题面'}</strong><p>自动识别题目描述、输入输出、测试样例、数据范围和提示。<br />已有文字中的对应区域会被替换，缺少的区域会添加。</p></div>}</div>
    </div>
    <div className="recognition-footer"><span role="status">{busy ? progress : progress || '识别后可修改文字、调整映射区域或取消勾选。'}</span><div><button className="small-button ai-organize-button" aria-label="AI 整理识别结果" disabled={busy || applicable.length === 0} onClick={() => setAiOrganizing(true)}><Sparkles size={13} />AI 整理</button><button className="small-button" onClick={() => { if (busy) controller.current?.abort(); else close(); }}>{busy ? '取消识别' : '取消'}</button><button className="primary-button" disabled={busy || applicable.length === 0} onClick={() => onApply(applicable)}><Check size={14} />应用到题面</button></div></div>
    {aiOrganizing && <AiStatementDialog statement={mergeRecognizedStatement('', applicable)} draft settingsRevision={aiSettingsRevision} onConfigure={onAiConfigure} onClose={() => setAiOrganizing(false)} onApply={result => {
      const replacements = new Map<RecognizedSectionKind, RecognizedSection>();
      const reservedIds = new Set(sections.map(section => section.id));
      for (const section of result) {
        const existing = replacements.get(section.kind);
        if (existing) { existing.content += `\n\n${section.content}`; continue; }
        const original = sections.filter(item => item.kind === section.kind);
        let id = original[0]?.id || section.id;
        if (!original.length) {
          let suffix = 1;
          while (reservedIds.has(id)) id = `${section.id}-${suffix++}`;
        }
        reservedIds.add(id);
        replacements.set(section.kind, { ...section, id, regions: original.flatMap(item => item.regions) });
      }
      const mapped: RecognizedSection[] = [];
      const replaced = new Set<RecognizedSectionKind>();
      const nextIncluded = new Set(included);
      for (const original of sections) {
        const replacement = replacements.get(original.kind);
        if (!replacement) { mapped.push(original); continue; }
        nextIncluded.delete(original.id);
        if (!replaced.has(original.kind)) { mapped.push(replacement); replaced.add(original.kind); }
      }
      for (const [kind, section] of replacements) {
        if (!replaced.has(kind)) mapped.push(section);
        nextIncluded.add(section.id);
      }
      setSections(mapped); setIncluded(nextIncluded); setActiveSection(mapped.some(section => section.id === activeSection) ? activeSection : mapped[0]?.id || ''); setAiOrganizing(false); setProgress('已将 AI 整理结果更新到识别草稿，请校对后应用。');
    }} />}
  </dialog>, document.body);
}
