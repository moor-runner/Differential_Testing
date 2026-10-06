import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import { fitImageSize, type ImageSize } from './imageSize';

export interface PreviewImage extends ImageSize { src: string; alt: string }

export function ImageViewer({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [original, setOriginal] = useState(false);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const fit = fitImageSize(image, { width: viewport.width - 82, height: viewport.height - 174 });
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    const element = dialog.current;
    element?.showModal();
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); element?.close(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="image-viewer" aria-labelledby={titleId} style={{ width: Math.max(320, fit.width + 34) }} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
    <div className="image-viewer-heading"><div><strong id={titleId}>图片预览</strong><span title={image.alt}>{image.alt}</span></div><button className="icon-button" aria-label="关闭图片预览" title="关闭（Esc）" onClick={onClose}><X size={18} /></button></div>
    <div className={`image-viewer-stage ${original ? 'original' : 'fit'}`} style={{ height: Math.max(80, fit.height + 32) }}><img src={image.src} alt={image.alt} style={{ width: original ? image.width : fit.width, height: 'auto', maxWidth: 'none' }} /></div>
    <div className="image-viewer-footer"><span>{image.width} × {image.height} px · {original ? '100%' : `${Math.round(fit.scale * 100)}%`}</span><div><button className={!original ? 'selected' : ''} onClick={() => setOriginal(false)}><Maximize2 size={12} />适应窗口</button><button className={original ? 'selected' : ''} onClick={() => setOriginal(true)}>原始尺寸</button></div></div>
  </dialog>, document.body);
}

export function StatementImage({ src, alt = '题面图片', onPreview }: { src: string; alt?: string; onPreview: (image: PreviewImage) => void }) {
  const [size, setSize] = useState<ImageSize | null>(null);
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="statement-image-error">图片加载失败，请检查本地服务或图片文件。</span>;
  return <button className="statement-image" aria-label={`查看图片：${alt}`} title={size ? `${size.width} × ${size.height} · 点击查看大图` : alt} onClick={() => { if (size) onPreview({ src, alt, ...size }); }}><img src={src} alt={alt} loading="eager" decoding="async" onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} /></button>;
}
