import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { applyConsoleDelta, emptyConsole, isDebugActive, sameLines, type DebugConsole } from './debugModel';
import type { BreakpointsState } from './useBreakpoints';
import type { DebugConsoleDelta, DebugRole, DebugSnapshot, DebugVariable, Problem } from './types';

/** The test case being debugged; an empty expected output is run without comparison, as in the test panel. */
export interface DebugEntry { key?: string; label: string; input: string; expected: string }
export type DebugStep = 'over' | 'into' | 'out';

function message(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试。'; }

/**
 * One debug session of the open problem, followed over SSE: state events replace the snapshot when their version
 * is newer, output events extend the console. Switching to another problem stops the session.
 */
export function useDebugger(problem: Problem | null, breakpoints: BreakpointsState, forceSave: () => Promise<void>, onError: (text: string) => void) {
  const problemId = problem?.id ?? null;
  const [session, setSessionState] = useState<DebugSnapshot | null>(null);
  const sessionRef = useRef<DebugSnapshot | null>(null);
  const [output, setOutputState] = useState<DebugConsole>(emptyConsole);
  const outputRef = useRef(emptyConsole);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const commandRef = useRef(false);
  const lastRequest = useRef<{ role: DebugRole; entry: DebugEntry } | null>(null);
  const [request, setRequest] = useState<{ role: DebugRole; entry: DebugEntry } | null>(null);
  const [frameChoice, setFrameChoice] = useState<{ generation: number; index: number; variables: DebugVariable[] | null } | null>(null);
  const [statics, setStatics] = useState<{ generation: number; index: number; variables: DebugVariable[] } | null>(null);
  const callbacks = useRef({ forceSave, onError, breakpoints });
  callbacks.current = { forceSave, onError, breakpoints };

  function setSession(next: DebugSnapshot | null) { sessionRef.current = next; setSessionState(next); }
  function setOutput(next: DebugConsole) { outputRef.current = next; setOutputState(next); }

  const accept = useCallback((next: DebugSnapshot) => {
    const current = sessionRef.current;
    // Replies and events of a replaced session, or older than what is shown, are dropped.
    if (!current || current.id !== next.id || next.version < current.version) return;
    setSession(next);
  }, []);

  const fetchConsole = useCallback(async (id: string) => {
    try {
      const delta = await api.debugConsole(id, outputRef.current.length);
      if (sessionRef.current?.id !== id) return;
      const next = applyConsoleDelta(outputRef.current, delta);
      if (next) setOutput(next);
    } catch { /* the next output event retries */ }
  }, []);

  const appendOutput = useCallback((id: string, delta: DebugConsoleDelta) => {
    if (sessionRef.current?.id !== id) return;
    const next = applyConsoleDelta(outputRef.current, delta);
    if (next) setOutput(next); else void fetchConsole(id);
  }, [fetchConsole]);

  const sessionId = session?.id ?? null, terminated = session?.state === 'TERMINATED';
  useEffect(() => {
    if (!sessionId || terminated) return;
    let disposed = false;
    const source = new EventSource(api.debugEventsUrl(sessionId), { withCredentials: true });
    source.addEventListener('state', event => { try { accept(JSON.parse((event as MessageEvent).data) as DebugSnapshot); } catch { /* keep the last valid state */ } });
    source.addEventListener('output', event => { try { appendOutput(sessionId, JSON.parse((event as MessageEvent).data) as DebugConsoleDelta); } catch { /* the next delta repairs it */ } });
    // EventSource reconnects by itself; meanwhile one direct read keeps the state current.
    source.onerror = () => { if (!disposed) void api.debug(sessionId).then(accept).catch(() => undefined); };
    return () => { disposed = true; source.close(); };
  }, [sessionId, terminated, accept, appendOutput]);
  // A command reply can report the end before the last output event arrived over SSE.
  useEffect(() => { if (sessionId && terminated) void fetchConsole(sessionId); }, [sessionId, terminated, fetchConsole]);

  useEffect(() => {
    const current = sessionRef.current;
    if (!current || current.problemId === problemId) return;
    if (current.state !== 'TERMINATED') void api.debugCommand(current.id, 'stop').catch(() => undefined);
    setSession(null); setOutput(emptyConsole); lastRequest.current = null; setRequest(null); setFrameChoice(null); setStatics(null);
  }, [problemId]);

  const start = useCallback(async (role: DebugRole, entry: DebugEntry) => {
    if (!problemId || startingRef.current) return;
    startingRef.current = true; setStarting(true);
    try {
      await callbacks.current.forceSave();
      const snapshot = await api.startDebug({ problemId, role, label: entry.label, input: entry.input, expected: entry.expected.trim() ? entry.expected : null, breakpoints: callbacks.current.breakpoints.lines[role] });
      lastRequest.current = { role, entry }; setRequest({ role, entry });
      setOutput(emptyConsole); setFrameChoice(null); setStatics(null);
      setSession(snapshot);
    } catch (error) {
      callbacks.current.onError(`启动调试失败：${message(error)}`);
    } finally { startingRef.current = false; setStarting(false); }
  }, [problemId]);

  /** One command at a time: holding F8 steps as fast as the program answers instead of queueing presses. */
  const command = useCallback(async (action: (id: string) => Promise<DebugSnapshot>) => {
    const current = sessionRef.current;
    if (!isDebugActive(current) || commandRef.current) return;
    commandRef.current = true;
    try { accept(await action(current.id)); }
    catch (error) {
      // The program moved on (or ended) meanwhile; the next state event shows where it is.
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) void api.debug(current.id).then(accept).catch(() => undefined);
      else callbacks.current.onError(`调试操作失败：${message(error)}`);
    } finally { commandRef.current = false; }
  }, [accept]);

  const resume = useCallback(() => command(id => api.debugCommand(id, 'resume')), [command]);
  const pause = useCallback(() => command(id => api.debugCommand(id, 'pause')), [command]);
  const step = useCallback((kind: DebugStep) => command(id => api.debugStep(id, kind)), [command]);
  const runToLine = useCallback((line: number) => command(id => api.debugRunToLine(id, line)), [command]);
  const stop = useCallback(async () => {
    const current = sessionRef.current;
    if (!isDebugActive(current)) return;
    try { accept(await api.debugCommand(current.id, 'stop')); } catch { /* already ended */ }
  }, [accept]);
  /** Debugs the same case again with the current code; {@code latest} may supply the case's current contents. */
  const restart = useCallback(async (latest?: (key: string) => DebugEntry | undefined) => {
    const request = lastRequest.current;
    if (!request) return;
    await start(request.role, (request.entry.key && latest?.(request.entry.key)) || request.entry);
  }, [start]);

  // Breakpoints toggled during a session reach the program at once.
  const role = session?.role, roleLines = role ? breakpoints.lines[role] : undefined, active = isDebugActive(session);
  useEffect(() => {
    const current = sessionRef.current;
    if (!active || !current || !roleLines || sameLines(roleLines, current.breakpoints.map(breakpoint => breakpoint.line))) return;
    const timer = setTimeout(() => { void api.debugBreakpoints(current.id, roleLines).catch(() => undefined); }, 120);
    return () => clearTimeout(timer);
  }, [active, sessionId, roleLines]);

  const pauseState = session?.state === 'PAUSED' ? session.pause : null;
  const generation = session?.generation ?? 0;
  const frameIndex = frameChoice?.generation === generation ? frameChoice.index : pauseState?.frameIndex ?? 0;
  const frame = pauseState?.frames.find(item => item.index === frameIndex) ?? null;
  const variables: DebugVariable[] | null = !pauseState ? null : frameIndex === pauseState.frameIndex ? pauseState.variables
    : frameChoice?.generation === generation ? frameChoice.variables : null;

  const selectFrame = useCallback(async (index: number) => {
    const current = sessionRef.current, details = current?.state === 'PAUSED' ? current.pause : null;
    if (!current || !details) return;
    const at = current.generation;
    if (index === details.frameIndex) { setFrameChoice({ generation: at, index, variables: details.variables }); return; }
    setFrameChoice({ generation: at, index, variables: null });
    try {
      const { variables } = await api.debugFrame(current.id, at, index);
      setFrameChoice(choice => choice?.generation === at && choice.index === index ? { ...choice, variables } : choice);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) callbacks.current.onError(`读取调用栈帧失败：${message(error)}`);
    }
  }, []);

  /** A page of a variable's children in the current pause; rejects once the program has moved on. */
  const children = useCallback((reference: number, startAt: number, count: number) => {
    const current = sessionRef.current;
    if (!current || current.state !== 'PAUSED') return Promise.reject(new Error('程序未暂停'));
    return api.debugChildren(current.id, current.generation, reference, startAt, count);
  }, []);

  // Static fields of the paused frame's classes join the scope that inline values and hovers read.
  useEffect(() => {
    const current = sessionRef.current, groups = variables?.filter(variable => variable.kind === 'static' && variable.ref) ?? [];
    if (!current || current.state !== 'PAUSED' || !groups.length) return;
    let cancelled = false;
    void Promise.all(groups.map(group => api.debugChildren(current.id, current.generation, group.ref, 0, 500))).then(pages => {
      if (!cancelled) setStatics({ generation: current.generation, index: frameIndex, variables: pages.reverse().flatMap(page => page.variables) });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionId, generation, frameIndex, variables]);

  const scope = useMemo(() => {
    const map = new Map<string, DebugVariable>();
    if (statics?.generation === generation && statics.index === frameIndex) for (const variable of statics.variables) map.set(variable.name, variable);
    for (const variable of variables ?? []) if (variable.kind !== 'static' && variable.name !== 'this') map.set(variable.name, variable);
    return map;
  }, [variables, statics, generation, frameIndex]);

  const visible = session && session.problemId === problemId ? session : null;
  const defaultFrame = pauseState?.frames.find(item => item.index === pauseState.frameIndex);
  return {
    session: visible, console: output, request: visible ? request : null, starting, active: isDebugActive(visible),
    start, resume, pause, step, runToLine, stop, restart, selectFrame, children,
    frameIndex, frame, variables, scope,
    /** Where the program is in the user's code, and the selected caller's line when another frame is chosen. */
    currentLine: defaultFrame?.user && defaultFrame.line > 0 ? defaultFrame.line : null,
    frameLine: frame && frame.user && frame.line > 0 && frame.index !== pauseState?.frameIndex ? frame.line : null,
  };
}
export type DebuggerState = ReturnType<typeof useDebugger>;
