import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { LoaderCircle, Minimize, MoreHorizontal, Undo2 } from 'lucide-react';
import { api } from './api';
import { ImageViewer, StatementImage, type PreviewImage } from './ImageViewer';
import { StatementRecognitionDialog } from './StatementRecognitionDialog';
import { AiSettingsDialog } from './AiSettingsDialog';
import { AiStatementDialog } from './AiStatementDialog';
import { applyAiStatement } from './aiStatement';
import { statementImages } from './statementImages';
import { cleanRecognizedStatement, mergeRecognizedStatement, type RecognizedSection } from './statementRecognition';

const remarkPlugins = [remarkGfm, remarkMath], rehypePlugins = [rehypeKatex];
const urlTransform = (url: string) => url.startsWith('/api/images/') || url.startsWith('#') ? url : '';

export function Statement({ value, onChange, onError, onUpload, problemId, fullscreen = false, title, onExitFullscreen, fontSize = 14, immersive = false }: { value: string; onChange: (value: string) => void; onError: (message: string) => void; onUpload: (operation: Promise<void>) => void; problemId: string; fullscreen?: boolean; title?: string; onExitFullscreen?: () => void; fontSize?: number; immersive?: boolean }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [uploadCount, setUploadCount] = useState(0);
  const uploading = uploadCount > 0;
  const [dragOver, setDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const [recognition, setRecognition] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [aiOrganization, setAiOrganization] = useState(false);
  const [aiSettings, setAiSettings] = useState(false);
  const [aiSettingsRevision, setAiSettingsRevision] = useState(0);
  const [replacement, setReplacement] = useState<{ before: string; after: string } | null>(null);
  const [tools, setTools] = useState(false);
  const toolsMenu = useRef<HTMLDivElement>(null);
  const controllers = useRef(new Set<AbortController>());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const slideUntil = useRef(0);
  const recognizeSelection = useRef(false);
  const sources = statementImages(value);
  const latest = useRef({ value, problemId, onChange });
  latest.current = { value, problemId, onChange };
  // 代码区每敲一个键都会让本组件随 App 重渲染：预览只随题面文字变化，且 img 组件须保持同一类型，否则 Markdown/KaTeX 每键重新解析、题面图片每键卸载重建。
  const components = useMemo<Components>(() => ({ img: ({ src, alt }) => src ? <StatementImage src={src} alt={alt || '题面图片'} onPreview={setPreview} /> : <span className="muted">[仅支持本地上传的图片]</span> }), []);
  const markdown = useMemo(() => <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform} components={components}>{value || '*还没有题面。点击右上角「编辑」粘贴文字或截图。*'}</ReactMarkdown>, [value, components]);
  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); }, []);
  // 沉浸编辑收起或展开边栏时正文顶边随之移动：同步滚动让文字停在原处，滚到顶无法抵消的部分展开时补回。
  useLayoutEffect(() => { slideUntil.current = performance.now() + 450; }, [immersive]);
  useEffect(() => {
    const element = content.current!;
    let anchor: number | null = null, drift = 0;
    const observer = new ResizeObserver(() => {
      if (!element.clientHeight) { anchor = null; return; }
      const top = element.getBoundingClientRect().top, shift = anchor === null || performance.now() > slideUntil.current ? 0 : top - anchor;
      anchor = top;
      if (!shift) return;
      const scroller = element.querySelector('textarea') ?? element, before = scroller.scrollTop;
      scroller.scrollTop = before + shift + drift;
      drift += shift - (scroller.scrollTop - before);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!uploadStatus || uploading) return;
    const timer = setTimeout(() => setUploadStatus(''), 4000);
    return () => clearTimeout(timer);
  }, [uploadStatus, uploading]);
  useEffect(() => {
    if (!tools) return;
    const closeOutside = (event: PointerEvent) => { if (!toolsMenu.current?.contains(event.target as Node)) setTools(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setTools(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [tools]);
  function tool(action: () => void) { return () => { setTools(false); action(); }; }
  function upload(files: File[], showPreview = false, recognize = false) {
    if (!files.length) return;
    if (files.some(file => !/\.(png|jpe?g|gif)$/i.test(file.name) && !['image/png', 'image/jpeg', 'image/gif'].includes(file.type))) { onError('请选择 PNG、JPEG 或 GIF 图片。'); return; }
    if (files.some(file => file.size > 10 * 1024 * 1024)) { onError('单张图片上限为 10 MiB，请选择较小的图片。'); return; }
    const images = files;
    const originalProblem = problemId;
    let cursor = mode === 'edit' ? textarea.current?.selectionStart ?? value.length : value.length;
    const controller = new AbortController();
    controllers.current.add(controller);
    setUploadCount(count => count + 1);
    const operation = (async () => { try {
      for (let index = 0; index < images.length; index++) {
        const file = images[index];
        setUploadStatus(`正在保存图片 ${index + 1}/${images.length}`);
        const result = await api.upload(file, controller.signal);
        if (latest.current.problemId !== originalProblem) return;
        const text = latest.current.value;
        const insertion = `\n![${file.name.replace(/[\[\]\\\r\n]/g, '')}](${result.url})\n`;
        const at = Math.min(cursor, text.length);
        const updated = text.slice(0, at) + insertion + text.slice(at);
        cursor = at + insertion.length;
        latest.current.value = updated;
        latest.current.onChange(updated);
      }
      setMode(showPreview ? 'preview' : 'edit');
      setUploadStatus(`已插入 ${images.length} 张图片`);
      if (recognize) setRecognition(true);
      if (!showPreview) requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(cursor, cursor); });
    } finally { controllers.current.delete(controller); setUploadCount(count => count - 1); } })();
    onUpload(operation);
    void operation.catch(error => { setUploadStatus('图片未全部插入，请重试'); onError(error instanceof Error ? error.message : '图片保存失败'); });
  }
  function applyRecognition(sections: RecognizedSection[]) {
    const before = latest.current.value;
    const after = mergeRecognizedStatement(before, sections);
    setReplacement({ before, after });
    latest.current.value = after;
    latest.current.onChange(after);
    setRecognition(false); setMode('preview');
    setUploadStatus(`已将 ${sections.length} 个识别区域应用到题面`);
  }
  function organize() {
    if (sources.length) { setOrganizing(true); setRecognition(true); return; }
    const before = latest.current.value, after = cleanRecognizedStatement(before);
    setReplacement({ before, after }); latest.current.value = after; latest.current.onChange(after);
    setMode('preview'); setUploadStatus('已整理题面段落，可撤销本次整理');
  }
  function applyAi(sections: RecognizedSection[]) {
    const before = latest.current.value, after = applyAiStatement(before, sections);
    setReplacement({ before, after }); latest.current.value = after; latest.current.onChange(after);
    setAiOrganization(false); setMode('preview'); setUploadStatus('已将 AI 整理结果应用到题面，可撤销');
  }
  return <section className={`panel statement-panel ${dragOver ? 'drag-over' : ''}`} style={{ '--reading-size': `${fontSize}px` } as CSSProperties} onDragOver={event => { if (mode === 'edit' && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragOver(true); } }} onDragLeave={() => setDragOver(false)} onDrop={event => { if (mode === 'edit') { event.preventDefault(); setDragOver(false); void upload(Array.from(event.dataTransfer.files)); } }}>
    <div className="panel-heading statement-heading edge-bar-top"><div className="panel-title"><strong title={fullscreen ? title : undefined}>{fullscreen ? title || '题面' : '题面'}</strong></div><div className="statement-heading-actions">
      <span className="statement-status" role="status">{uploadStatus}</span>
      {uploading && <button className="text-button" onClick={() => { for (const controller of controllers.current) controller.abort(); }}>取消</button>}
      {replacement && value === replacement.after && <button className="icon-button" title="撤销本次题面替换" aria-label="撤销识别替换" onClick={() => { latest.current.value = replacement.before; latest.current.onChange(replacement.before); setReplacement(null); setUploadStatus('已撤销题面替换'); }}><Undo2 size={14} /></button>}
      <div className="segmented"><button className={mode === 'preview' ? 'selected' : ''} onClick={() => setMode('preview')} title="预览 Markdown 与公式">预览</button><button className={mode === 'edit' ? 'selected' : ''} onClick={() => setMode('edit')} title="编辑题面（支持粘贴、拖入图片）">编辑</button></div>
      <div className="menu-anchor" ref={toolsMenu}><button className="icon-button" aria-label="题面工具" title="插图、识别与整理" aria-expanded={tools} onClick={() => setTools(value => !value)}>{uploading ? <LoaderCircle size={14} className="spin" /> : <MoreHorizontal size={15} />}</button>
        {tools && <div className="menu" role="menu" aria-label="题面工具">
          <button role="menuitem" aria-label="上传题面图片" disabled={uploading} onClick={tool(() => { recognizeSelection.current = false; fileInput.current?.click(); })}>插入图片</button>
          <button role="menuitem" aria-label="识别图片题目" title={sources.length ? '识别题面中的图片并映射到文字区域' : '选择题目截图并识别为文字'} disabled={uploading} onClick={tool(() => { setOrganizing(false); if (sources.length) setRecognition(true); else { recognizeSelection.current = true; fileInput.current?.click(); } })}>识别截图</button>
          <button role="menuitem" aria-label="整理题面" title={sources.length ? '从原图重新识别，清理无关内容并整理段落' : '整理中文间距与段落换行'} disabled={uploading || !value.trim()} onClick={tool(organize)}>整理排版</button>
          <div className="menu-separator" />
          <button role="menuitem" aria-label="AI 整理题面" title="使用配置的 AI 服务整理题面，预览后应用" disabled={uploading || !value.trim()} onClick={tool(() => setAiOrganization(true))}>AI 整理</button>
          <button role="menuitem" aria-label="AI 设置" onClick={tool(() => setAiSettings(true))}>AI 设置</button>
        </div>}
      </div>
      {fullscreen && <button className="icon-button" type="button" aria-label="退出全屏" title="退出全屏（Esc / F11）" onClick={onExitFullscreen}><Minimize size={15} /></button>}
    </div></div>
    <div className="statement-content" ref={content}>{mode === 'edit' ? <textarea ref={textarea} className="statement-textarea" aria-label="Markdown 题面" value={value} spellCheck={false} onChange={event => onChange(event.target.value)} onPaste={event => { const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void upload(images); } }} placeholder={'# 题目标题\n\n在这里粘贴题面，或拖入题目截图。\n\n支持 Markdown 和 $LaTeX$ 公式。'} /> : <article className="markdown">{markdown}</article>}</div>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif" multiple hidden onChange={event => { void upload(Array.from(event.target.files || []), true, recognizeSelection.current); recognizeSelection.current = false; event.target.value = ''; }} />
    {preview && <ImageViewer image={preview} onClose={() => setPreview(null)} />}
    {recognition && sources.length > 0 && <StatementRecognitionDialog sources={sources} autoStart={organizing} aiSettingsRevision={aiSettingsRevision} onAiConfigure={() => setAiSettings(true)} onApply={applyRecognition} onClose={() => setRecognition(false)} />}
    {aiOrganization && <AiStatementDialog statement={value} settingsRevision={aiSettingsRevision} onConfigure={() => setAiSettings(true)} onApply={applyAi} onClose={() => setAiOrganization(false)} />}
    {aiSettings && <AiSettingsDialog onClose={() => setAiSettings(false)} onSaved={() => setAiSettingsRevision(revision => revision + 1)} />}
  </section>;
}
