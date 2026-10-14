import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { normalizeLines, sameLines } from './debugModel';
import type { Breakpoints, Role } from './types';

const none: Breakpoints = { generator: [], brute: [], optimized: [] };
function message(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试。'; }

/** Breakpoint lines of the open problem's three programs, saved per problem shortly after each change. */
export function useBreakpoints(problemId: string | null, onError: (text: string) => void) {
  const [state, setState] = useState<{ problemId: string | null; lines: Breakpoints; ready: boolean }>({ problemId: null, lines: none, ready: false });
  const stateRef = useRef(state);
  const pending = useRef(new Map<string, Breakpoints>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  function apply(next: typeof state) { stateRef.current = next; setState(next); }

  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    while (saving.current) await saving.current;
    const operation = async () => {
      for (const [id, lines] of [...pending.current]) {
        try {
          await api.saveBreakpoints(id, lines);
          if (pending.current.get(id) === lines) pending.current.delete(id);
        } catch (error) {
          // The problem was deleted meanwhile, and its breakpoints with it.
          if (error instanceof ApiError && error.status === 404) { pending.current.delete(id); continue; }
          errorRef.current(`断点保存失败：${message(error)}`);
          throw error;
        }
      }
    };
    saving.current = operation();
    try { await saving.current; } finally { saving.current = null; }
  }, []);

  useEffect(() => {
    if (!problemId) { apply({ problemId: null, lines: none, ready: false }); return; }
    let cancelled = false;
    apply({ problemId, lines: pending.current.get(problemId) ?? none, ready: false });
    void (async () => {
      try {
        await flush().catch(() => undefined);
        const lines = await api.breakpoints(problemId);
        if (!cancelled) apply({ problemId, lines: { ...none, ...lines }, ready: true });
      } catch (error) {
        if (cancelled) return;
        // Breakpoints are a convenience: the editor stays usable and new ones are kept for this session.
        apply({ problemId, lines: none, ready: true });
        errorRef.current(`读取断点失败：${message(error)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [problemId, flush]);

  /** Replaces one program's breakpoints, e.g. after edits moved them; unchanged lists do nothing. */
  const set = useCallback((role: Role, lines: Iterable<number>) => {
    const current = stateRef.current;
    if (!current.problemId || !current.ready) return;
    const next = normalizeLines(lines);
    if (sameLines(next, current.lines[role])) return;
    const all = { ...current.lines, [role]: next };
    apply({ ...current, lines: all });
    pending.current.set(current.problemId, all);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flush().catch(() => undefined); }, 500);
  }, [flush]);

  const toggle = useCallback((role: Role, line: number) => {
    const lines = stateRef.current.lines[role];
    set(role, lines.includes(line) ? lines.filter(value => value !== line) : [...lines, line]);
  }, [set]);

  const lines = state.problemId === problemId ? state.lines : none;
  return { lines, ready: state.problemId === problemId && state.ready, set, toggle, flush };
}
export type BreakpointsState = ReturnType<typeof useBreakpoints>;
