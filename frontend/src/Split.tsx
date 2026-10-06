import { Children, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

interface Props { direction?: 'horizontal' | 'vertical'; sizes: number[]; onChange: (value: number[]) => void; children: ReactNode; label: string }
export function Split({ direction = 'horizontal', sizes, onChange, children, label }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const panes = Children.toArray(children);
  const current = sizes.length === panes.length && sizes.every(n => Number.isFinite(n) && n > 0) ? sizes : panes.map(() => 100 / panes.length);
  function adjust(index: number, amount: number, baseline = current) {
    const next = [...baseline];
    const pair = baseline[index] + baseline[index + 1];
    const minimum = Math.min(8, pair / 4);
    next[index] = Math.max(minimum, Math.min(pair - minimum, baseline[index] + amount));
    next[index + 1] = pair - next[index];
    onChange(next);
  }
  function drag(event: PointerEvent<HTMLDivElement>, index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const rect = container.current!.getBoundingClientRect();
    const extent = direction === 'horizontal' ? rect.width : rect.height;
    const start = direction === 'horizontal' ? event.clientX : event.clientY;
    const baseline = [...current];
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    function move(moveEvent: globalThis.PointerEvent) { adjust(index, ((direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY) - start) / extent * baseline.reduce((a, b) => a + b, 0), baseline); }
    function stop() { document.body.classList.remove('resizing'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>, index: number) {
    const negative = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const positive = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === negative || event.key === positive) { event.preventDefault(); adjust(index, (event.key === positive ? 1 : -1) * (event.shiftKey ? 5 : 1)); }
  }
  return <div className={`split split-${direction}`} ref={container}>{panes.map((pane, i) => <div key={i} className="split-fragment" style={{ display: 'contents' }}><div className="split-pane" style={{ flexGrow: current[i], flexBasis: 0 }}>{pane}</div>{i < panes.length - 1 && <div className="split-handle" role="separator" aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'} aria-label={`${label} ${i + 1}（方向键调整）`} aria-valuenow={Math.round(current[i])} aria-valuemin={8} aria-valuemax={92} tabIndex={0} onPointerDown={e => drag(e, i)} onKeyDown={e => keyboard(e, i)}><span /></div>}</div>)}</div>;
}
