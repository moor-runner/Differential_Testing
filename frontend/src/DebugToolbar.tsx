import { ArrowDownToDot, ArrowUpFromDot, Pause, Play, RedoDot, RotateCcw, Square, TextCursor } from 'lucide-react';
import { debugStatus } from './debugModel';
import type { DebuggerState, DebugStep } from './useDebugger';

interface Props { debug: DebuggerState; onRunToCursor: () => void; onRestart: () => void; compact: boolean }

/** Floats over the editor being debugged, so stepping happens right where the code is (shortcuts as in IDEA). */
export function DebugToolbar({ debug, onRunToCursor, onRestart, compact }: Props) {
  const session = debug.session;
  if (!session || session.state === 'TERMINATED') return null;
  const paused = session.state === 'PAUSED', running = session.state === 'RUNNING';
  const tone = session.pause?.reason === 'exception' ? 'exception' : paused ? 'paused' : 'running';
  const step = (kind: DebugStep) => () => { void debug.step(kind); };
  return <div className={`debug-toolbar ${compact ? 'is-compact' : ''}`} role="toolbar" aria-label="调试控制" onMouseDown={event => event.preventDefault()}>
    <span className={`debug-toolbar-status tone-${tone}`} title={session.message}><span className="debug-status-dot" />{debugStatus(session)}</span>
    <span className="debug-toolbar-separator" />
    {paused ? <button type="button" className="icon-button" title="继续运行（F9）" aria-label="继续运行" onClick={() => { void debug.resume(); }}><Play size={13} /></button>
      : <button type="button" className="icon-button" title="暂停（F9）" aria-label="暂停" disabled={!running} onClick={() => { void debug.pause(); }}><Pause size={13} /></button>}
    <button type="button" className="icon-button" title="单步跳过（F8）" aria-label="单步跳过" disabled={!paused} onClick={step('over')}><RedoDot size={13} /></button>
    <button type="button" className="icon-button" title="单步进入（F7）" aria-label="单步进入" disabled={!paused} onClick={step('into')}><ArrowDownToDot size={13} /></button>
    <button type="button" className="icon-button" title="单步跳出（Shift+F8）" aria-label="单步跳出" disabled={!paused} onClick={step('out')}><ArrowUpFromDot size={13} /></button>
    <button type="button" className="icon-button" title="运行到光标所在行（Alt+F9）" aria-label="运行到光标" disabled={!paused} onClick={onRunToCursor}><TextCursor size={13} /></button>
    <span className="debug-toolbar-separator" />
    <button type="button" className="icon-button" title="重新调试（Ctrl+F5）" aria-label="重新调试" disabled={debug.starting} onClick={onRestart}><RotateCcw size={12} /></button>
    <button type="button" className="icon-button debug-stop" title="停止调试（Ctrl+F2）" aria-label="停止调试" onClick={() => { void debug.stop(); }}><Square size={11} fill="currentColor" /></button>
  </div>;
}
