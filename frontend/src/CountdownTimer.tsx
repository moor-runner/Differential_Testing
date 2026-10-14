import { useEffect, useState } from 'react';
import { Pause, Play, RotateCcw, Timer } from 'lucide-react';
import { formatCountdown, parseCountdown } from './countdown';

// 运行中记录结束时刻而不是逐秒递减，窗口被节流或系统休眠后剩余时间仍按真实时间计算。
type State = { status: 'idle' } | { status: 'running'; endAt: number } | { status: 'paused'; remainingMs: number } | { status: 'done' };

// 结束提示音：三声短促的 880Hz；没有音频设备或被系统禁止时只保留红色闪烁。
function chime() {
  try {
    const audio = new AudioContext();
    for (let index = 0; index < 3; index++) {
      const at = audio.currentTime + index * 0.3, tone = audio.createOscillator(), gain = audio.createGain();
      tone.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      tone.connect(gain).connect(audio.destination);
      tone.start(at); tone.stop(at + 0.22);
    }
    setTimeout(() => { void audio.close().catch(() => undefined); }, 1500);
  } catch { /* 视觉提示仍然有效 */ }
}

export function CountdownTimer({ duration, onDurationChange }: { duration: number; onDurationChange: (seconds: number) => void }) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [left, setLeft] = useState(duration);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (state.status !== 'running') return;
    const { endAt } = state;
    const tick = () => {
      const remaining = endAt - Date.now();
      if (remaining > 0) setLeft(Math.ceil(remaining / 1000));
      else { clearInterval(timer); setState({ status: 'done' }); chime(); }
    };
    const timer = setInterval(tick, 250);
    tick();
    return () => clearInterval(timer);
  }, [state]);

  function start(seconds: number) { setLeft(seconds); setState({ status: 'running', endAt: Date.now() + seconds * 1000 }); }
  function toggle() {
    if (state.status === 'running') setState({ status: 'paused', remainingMs: Math.max(0, state.endAt - Date.now()) });
    else if (state.status === 'paused') setState({ status: 'running', endAt: Date.now() + state.remainingMs });
    else start(duration);
  }
  // 回车保存并开始；失焦只保存；输入无效时回车保持编辑，失焦放弃。
  function commit(startNow: boolean) {
    const seconds = parseCountdown(draft ?? '');
    if (seconds === undefined) { if (!startNow) setDraft(null); return; }
    setDraft(null);
    if (seconds !== duration) onDurationChange(seconds);
    if (startNow) start(seconds);
  }

  const shown = state.status === 'idle' ? duration : state.status === 'paused' ? Math.ceil(state.remainingMs / 1000) : state.status === 'done' ? 0 : left;
  const time = formatCountdown(shown);
  return <div className={`countdown is-${state.status}`} role="group" aria-label="倒计时">
    <Timer size={13} aria-hidden="true" />
    {draft !== null ? <input className="countdown-input" autoFocus value={draft} aria-label="倒计时时长" aria-invalid={parseCountdown(draft) === undefined} placeholder="分钟"
        title="输入分钟数，或 分:秒、时:分:秒；回车开始，Esc 取消" onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)} onBlur={() => commit(false)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(true); } else if (event.key === 'Escape') setDraft(null); }} />
      : state.status === 'idle' ? <button type="button" className="countdown-time" title="点击设置倒计时时长" aria-label={`倒计时 ${time}，点击设置时长`} onClick={() => setDraft(time)}>{time}</button>
      : state.status === 'done' ? <button type="button" className="countdown-time" title="时间到，点击复位" aria-label="时间到，点击复位倒计时" onClick={() => setState({ status: 'idle' })}>{time}</button>
      : <span className="countdown-time" role="timer">{time}</span>}
    {draft === null && state.status !== 'done' && <button type="button" className="icon-button" aria-label={state.status === 'running' ? '暂停倒计时' : state.status === 'paused' ? '继续倒计时' : '开始倒计时'} title={state.status === 'running' ? '暂停' : state.status === 'paused' ? '继续' : '开始'} onClick={toggle}>{state.status === 'running' ? <Pause size={12} /> : <Play size={12} />}</button>}
    {state.status !== 'idle' && <button type="button" className="icon-button" aria-label="重置倒计时" title="重置" onClick={() => setState({ status: 'idle' })}><RotateCcw size={12} /></button>}
  </div>;
}
