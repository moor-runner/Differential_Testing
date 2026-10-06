import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { FileText, ImagePlus, Eye, Pencil, LoaderCircle } from 'lucide-react';
import { api } from './api';

export function Statement({ value, onChange, onError, onUpload, problemId }: { value: string; onChange: (value: string) => void; onError: (message: string) => void; onUpload: (operation: Promise<void>) => void; problemId: string }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [uploadCount, setUploadCount] = useState(0);
  const uploading = uploadCount > 0;
  const [dragOver, setDragOver] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, problemId, onChange });
  latest.current = { value, problemId, onChange };
  function upload(files: File[]) {
    const images = files.filter(file => file.type.startsWith('image/'));
    if (!images.length) { onError('请选择图片文件。'); return; }
    const originalProblem = problemId;
    const cursor = textarea.current?.selectionStart ?? value.length;
    setUploadCount(count => count + 1);
    const operation = (async () => { try {
      const links: string[] = [];
      for (const file of images) { const result = await api.upload(file); links.push(`![${file.name.replace(/[\[\]\\]/g, '')}](${result.url})`); }
      if (latest.current.problemId === originalProblem) {
        const text = latest.current.value;
        const insertion = `\n${links.join('\n')}\n`;
        const at = Math.min(cursor, text.length);
        const updated = text.slice(0, at) + insertion + text.slice(at);
        latest.current.value = updated;
        latest.current.onChange(updated);
        setMode('edit');
        requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(at + insertion.length, at + insertion.length); });
      }
    } finally { setUploadCount(count => count - 1); } })();
    onUpload(operation);
    void operation.catch(error => onError(error instanceof Error ? error.message : '图片保存失败'));
  }
  return <section className={`panel statement-panel ${dragOver ? 'drag-over' : ''}`} onDragOver={event => { if (mode === 'edit') { event.preventDefault(); setDragOver(true); } }} onDragLeave={() => setDragOver(false)} onDrop={event => { if (mode === 'edit') { event.preventDefault(); setDragOver(false); void upload(Array.from(event.dataTransfer.files)); } }}>
    <div className="panel-heading"><div className="panel-title"><FileText size={15} /><strong>题面</strong></div><div className="segmented"><button className={mode === 'edit' ? 'selected' : ''} onClick={() => setMode('edit')} title="编辑题面"><Pencil size={12} />编辑</button><button className={mode === 'preview' ? 'selected' : ''} onClick={() => setMode('preview')} title="预览 Markdown 与公式"><Eye size={12} />预览</button></div></div>
    <div className="statement-content">{mode === 'edit' ? <textarea ref={textarea} className="statement-textarea" aria-label="Markdown 题面" value={value} spellCheck={false} onChange={event => onChange(event.target.value)} onPaste={event => { const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void upload(images); } }} placeholder={'# 题目标题\n\n在这里粘贴题面，或拖入题目截图。\n\n支持 Markdown 和 $LaTeX$ 公式。'} /> : <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} urlTransform={url => url.startsWith('/api/images/') || url.startsWith('#') ? url : ''} components={{ img: props => props.src ? <img {...props} alt={props.alt || '题面图片'} loading="lazy" /> : <span className="muted">[仅支持本地上传的图片]</span> }}>{value || '# 开始记录这道题\n\n点击右上角 **编辑**，粘贴题面文字或图片。\n\n题面、代码与运行记录会自动保存到本地。'}</ReactMarkdown></article>}</div>
    <div className="statement-footer"><span>{mode === 'edit' ? 'Markdown · 支持粘贴 / 拖入图片' : 'Markdown + LaTeX'}</span><button className="icon-button" title="上传题面图片" aria-label="上传题面图片" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}</button><input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} /></div>
  </section>;
}
