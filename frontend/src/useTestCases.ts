import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { statementSamples } from './statementSamples';
import type { Problem, TestCase, TestCaseResult, TestRole, TestRun } from './types';

/** Statement samples come first and are read-only; custom cases follow in their saved order. */
export interface TestEntry { key: string; label: string; source: 'sample' | 'custom'; input: string; expected: string; ai?: { category?: string; note?: string } }
/** What a case looked like when it ran, so edits after the run mark its result as outdated. */
export interface TestRecord { input: string; expected: string; result: TestCaseResult | null }
export interface TestOutcome { problemId: string; role: TestRole; run: TestRun; records: Record<string, TestRecord> }
interface Running { runId: string; problemId: string; keys: string[]; cancelled: boolean }

function message(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试。'; }

export function freshRecord(outcome: TestOutcome | null, entry: TestEntry) {
  const record = outcome?.records[entry.key];
  return record && record.input === entry.input && record.expected === entry.expected ? record : undefined;
}

export function useTestCases(problem: Problem | null, forceSave: () => Promise<void>, onError: (text: string) => void) {
  const problemId = problem?.id ?? null;
  const [state, setState] = useState<{ problemId: string | null; custom: TestCase[]; status: 'loading' | 'ready' | 'failed' }>({ problemId: null, custom: [], status: 'loading' });
  const stateRef = useRef(state);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [running, setRunningState] = useState<Running | null>(null);
  const runningRef = useRef<Running | null>(null);
  const pending = useRef(new Map<string, TestCase[]>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const callbacks = useRef({ forceSave, onError });
  callbacks.current = { forceSave, onError };
  function apply(next: typeof state) { stateRef.current = next; setState(next); }
  function setRunning(next: Running | null) { runningRef.current = next; setRunningState(next); }

  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    while (saving.current) await saving.current;
    const operation = async () => {
      for (const [id, tests] of [...pending.current]) {
        try {
          await api.saveTests(id, tests);
          if (pending.current.get(id) === tests) pending.current.delete(id);
        } catch (error) {
          // The problem was deleted meanwhile; its cases went with it.
          if (error instanceof ApiError && error.status === 404) { pending.current.delete(id); continue; }
          callbacks.current.onError(`自定义用例保存失败：${message(error)}`);
          throw error;
        }
      }
    };
    saving.current = operation();
    try { await saving.current; } finally { saving.current = null; }
  }, []);

  useEffect(() => {
    if (!problemId) return;
    let cancelled = false;
    apply({ problemId, custom: [], status: 'loading' });
    void (async () => {
      try {
        await flush().catch(() => undefined);
        const custom = await api.tests(problemId);
        if (!cancelled) apply({ problemId, custom, status: 'ready' });
      } catch (error) {
        if (cancelled) return;
        apply({ problemId, custom: [], status: 'failed' });
        callbacks.current.onError(`读取自定义用例失败：${message(error)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [problemId, reloadToken, flush]);

  const updateCustom = useCallback((custom: TestCase[]) => {
    const current = stateRef.current;
    if (!current.problemId || current.status !== 'ready') return;
    apply({ ...current, custom });
    pending.current.set(current.problemId, custom);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flush().catch(() => undefined); }, 600);
  }, [flush]);

  const statement = problem?.statement ?? '';
  const samples = useMemo(() => statementSamples(statement), [statement]);
  const custom = state.problemId === problemId ? state.custom : [];
  const entries = useMemo<TestEntry[]>(() => [
    ...samples.map((sample, index) => ({ key: `sample-${index}`, label: `样例 ${index + 1}`, source: 'sample' as const, ...sample })),
    ...custom.map((test, index) => ({ key: test.id, label: `用例 ${index + 1}`, source: 'custom' as const, input: test.input, expected: test.expected, ...(test.source === 'ai' ? { ai: { category: test.category, note: test.note } } : {}) })),
  ], [samples, custom]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const run = useCallback(async (role: TestRole, keys?: string[]) => {
    if (runningRef.current || !problemId) return;
    const selected = entriesRef.current.filter(entry => !keys || keys.includes(entry.key));
    if (!selected.length) { callbacks.current.onError('没有可运行的测试用例。题面中未找到样例时，请先添加自定义用例。'); return; }
    const current: Running = { runId: crypto.randomUUID(), problemId, keys: selected.map(entry => entry.key), cancelled: false };
    setRunning(current);
    try {
      await callbacks.current.forceSave();
      if (current.cancelled) return;
      const result = await api.runTests({ problemId, role, runId: current.runId, cases: selected.map(entry => ({ input: entry.input, expected: entry.expected.trim() ? entry.expected : null })) });
      setOutcome(previous => {
        // A single-case run keeps the other cases' results from the same solver.
        const records = previous?.problemId === problemId && previous.role === role && keys ? { ...previous.records } : {};
        selected.forEach((entry, index) => { records[entry.key] = { input: entry.input, expected: entry.expected, result: result.results[index] ?? null }; });
        return { problemId, role, run: result, records };
      });
    } catch (error) {
      callbacks.current.onError(`运行测试用例失败：${message(error)}`);
    } finally {
      if (runningRef.current === current) setRunning(null);
    }
  }, [problemId]);

  const cancel = useCallback(() => {
    const current = runningRef.current;
    if (!current || current.cancelled) return;
    current.cancelled = true;
    setRunningState({ ...current });
    void api.cancelTests(current.runId).catch(() => undefined);
  }, []);

  return {
    statement, entries, custom, status: state.problemId === problemId ? state.status : 'loading' as const,
    reload: () => setReloadToken(value => value + 1), updateCustom, flush,
    outcome: outcome?.problemId === problemId ? outcome : null,
    running: running?.problemId === problemId ? running : null, testing: !!running,
    run, cancel,
  };
}
export type TestCasesState = ReturnType<typeof useTestCases>;
