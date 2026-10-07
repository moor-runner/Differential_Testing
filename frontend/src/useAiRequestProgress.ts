import { useEffect, useRef, useState } from 'react';
import type { AiRequestSnapshot, AiTrackingNotice } from './api';

export function useAiRequestProgress() {
  const startedAt = useRef(0);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [snapshot, setSnapshot] = useState<AiRequestSnapshot | null>(null);
  const [notices, setNotices] = useState<AiTrackingNotice[]>([]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 500);
    return () => clearInterval(timer);
  }, [running]);
  function begin() { startedAt.current = Date.now(); setElapsedMs(0); setSnapshot(null); setNotices([]); setRunning(true); }
  function finish() { setElapsedMs(Date.now() - startedAt.current); setRunning(false); }
  function update(value: AiRequestSnapshot | AiTrackingNotice) {
    if ('notice' in value) setNotices(previous => [...previous, value].slice(-30));
    else setSnapshot(value);
  }
  function record(message: string, level: 'info' | 'error' = 'info') {
    setNotices(previous => [...previous, { id: '', notice: true as const, elapsedMs: Date.now() - startedAt.current, level, message }].slice(-30));
  }
  return { elapsedMs, snapshot, notices, begin, finish, update, record };
}
