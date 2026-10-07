import { Children, useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { visiblePane } from './displayPreferences';

interface Props { direction?: 'horizontal' | 'vertical'; sizes: number[]; onChange: (value: number[]) => void; children: ReactNode; label: string; activePane?: number; visible?: boolean }
export function Split({ direction = 'horizontal', sizes, onChange, children, label, activePane, visible = true }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const panes = Children.toArray(children);
  const single = visiblePane(activePane, panes.length);
  const current = Array.isArray(sizes) && sizes.length === panes.length && sizes.every(n => Number.isFinite(n) && n > 0) ? sizes : panes.map(() => 100 / panes.length);
  useEffect(() => { stopDrag.current?.(); }, [activePane, direction, visible]);
  useEffect(() => () => { stopDrag.current?.(); }, []);
  function adjust(index: number, amount: number, baseline = current) {
    const next = [...baseline];
    const pair = baseline[index] + baseline[index + 1];
    const minimum = Math.min(8, pair / 4);
    next[index] = Math.max(minimum, Math.min(pair - minimum, baseline[index] + amount));
    next[index + 1] = pair - next[index];
    onChange(next);
  }
  function drag(event: PointerEvent<HTMLDivElement>, index: number) {
    if (!visible || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const rect = container.current!.getBoundingClientRect();
    const extent = direction === 'horizontal' ? rect.width : rect.height;
    if (extent <= 0 || single !== undefined) return;
    stopDrag.current?.();
    const start = direction === 'horizontal' ? event.clientX : event.clientY;
    const baseline = [...current];
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    function move(moveEvent: globalThis.PointerEvent) { adjust(index, ((direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY) - start) / extent * baseline.reduce((a, b) => a + b, 0), baseline); }
    let stopped = false;
    function stop() {
      if (stopped) return;
      stopped = true; stopDrag.current = null;
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); handle.removeEventListener('lostpointercapture', stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    }
    stopDrag.current = stop;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('lostpointercapture', stop);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (!visible) return;
    const negative = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const positive = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === negative || event.key === positive) { event.preventDefault(); adjust(index, (event.key === positive ? 1 : -1) * (event.shiftKey ? 5 : 1)); }
  }
  return <div className={`split split-${direction}`} ref={container}>{panes.map((pane, i) => <div key={i} className="split-fragment" style={{ display: 'contents' }}><div className="split-pane" hidden={single !== undefined && single !== i} style={{ flexGrow: single === undefined ? current[i] : 1, flexBasis: 0, display: single !== undefined && single !== i ? 'none' : undefined }}>{pane}</div>{i < panes.length - 1 && <div className="split-handle" hidden={single !== undefined} style={{ display: single !== undefined ? 'none' : undefined }} role="separator" aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'} aria-label={`${label} ${i + 1}（方向键调整）`} aria-valuenow={Math.round(current[i])} aria-valuemin={8} aria-valuemax={92} tabIndex={single === undefined ? 0 : -1} onPointerDown={e => drag(e, i)} onKeyDown={e => keyboard(e, i)}><span /></div>}</div>)}</div>;
}
