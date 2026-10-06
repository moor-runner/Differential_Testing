import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { FileText, ImagePlus, Eye, Pencil, LoaderCircle } from 'lucide-react';
import { api } from './api';
import { ImageViewer, StatementImage, type PreviewImage } from './ImageViewer';

export function Statement({ value, onChange, onError, onUpload, problemId }: { value: string; onChange: (value: string) => void; onError: (message: string) => void; onUpload: (operation: Promise<void>) => void; problemId: string }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [uploadCount, setUploadCount] = useState(0);
  const uploading = uploadCount > 0;
  const [dragOver, setDragOver] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, problemId, onChange });
  latest.current = { value, problemId, onChange };
  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); }, []);
  function upload(files: File[], showPreview = false) {
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
      if (!showPreview) requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(cursor, cursor); });
    } finally { controllers.current.delete(controller); setUploadCount(count => count - 1); } })();
    onUpload(operation);
    void operation.catch(error => { setUploadStatus('图片未全部插入，请重试'); onError(error instanceof Error ? error.message : '图片保存失败'); });
  }
  return <section className={`panel statement-panel ${dragOver ? 'drag-over' : ''}`} onDragOver={event => { if (mode === 'edit') { event.preventDefault(); setDragOver(true); } }} onDragLeave={() => setDragOver(false)} onDrop={event => { if (mode === 'edit') { event.preventDefault(); setDragOver(false); void upload(Array.from(event.dataTransfer.files)); } }}>
    <div className="panel-heading"><div className="panel-title"><FileText size={15} /><strong>题面</strong></div><div className="segmented"><button className={mode === 'edit' ? 'selected' : ''} onClick={() => setMode('edit')} title="编辑题面"><Pencil size={12} />编辑</button><button className={mode === 'preview' ? 'selected' : ''} onClick={() => setMode('preview')} title="预览 Markdown 与公式"><Eye size={12} />预览</button></div></div>
    <div className="statement-content">{mode === 'edit' ? <textarea ref={textarea} className="statement-textarea" aria-label="Markdown 题面" value={value} spellCheck={false} onChange={event => onChange(event.target.value)} onPaste={event => { const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void upload(images); } }} placeholder={'# 题目标题\n\n在这里粘贴题面，或拖入题目截图。\n\n支持 Markdown 和 $LaTeX$ 公式。'} /> : <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} urlTransform={url => url.startsWith('/api/images/') || url.startsWith('#') ? url : ''} components={{ img: ({ src, alt }) => src ? <StatementImage src={src} alt={alt || '题面图片'} onPreview={setPreview} /> : <span className="muted">[仅支持本地上传的图片]</span> }}>{value || '# 开始记录这道题\n\n点击右上角 **编辑**，粘贴题面文字或图片。\n\n题面、代码与运行记录会自动保存到本地。'}</ReactMarkdown></article>}</div>
    <div className="statement-footer"><span role="status">{uploadStatus || (mode === 'edit' ? 'Markdown · 支持粘贴 / 拖入图片' : 'Markdown + LaTeX')}</span><div className="statement-upload-actions">{uploading && <button className="text-button" onClick={() => { for (const controller of controllers.current) controller.abort(); }}>取消</button>}<button className="icon-button" title="插入题面图片" aria-label="上传题面图片" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}</button></div><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif" multiple hidden onChange={event => { void upload(Array.from(event.target.files || []), true); event.target.value = ''; }} /></div>
    {preview && <ImageViewer image={preview} onClose={() => setPreview(null)} />}
  </section>;
}
