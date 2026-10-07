import type { Health, Job, Layout, Problem, ProblemSummary } from './types';
import type { OcrImage } from './statementRecognition';

export interface RecognitionStatus { available: boolean; languages: { tag: string; name: string }[]; message: string }
export interface AiSettings { baseUrl: string; model: string; apiKeyConfigured: boolean }
export interface AiSettingsUpdate { baseUrl: string; model: string; apiKey?: string; clearApiKey?: boolean }
export interface AiRequestLog { elapsedMs: number; level: 'info' | 'error'; message: string }
export interface AiRequestSnapshot {
  id: string; operation: 'organize' | 'test'; state: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  stage: string; message: string; elapsedMs: number; firstResponseMs: number | null;
  receivedCharacters: number; reasoningCharacters: number; httpStatus: number | null;
  thinkingDisabled: boolean; logs: AiRequestLog[];
}
export interface AiTrackingNotice extends AiRequestLog { id: string; notice: true }
export type AiProgressCallback = (update: AiRequestSnapshot | AiTrackingNotice) => void;

export class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init, headers: { ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  if (!response.ok) {
    const message = await response.text();
    let detail = message;
    try { const data = JSON.parse(message); detail = data.message || data.error || message; } catch { /* text error */ }
    throw new ApiError(detail || `请求失败 (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const json = (value: unknown) => JSON.stringify(value);

async function aiOperation<T>(operation: 'organize' | 'test', input: string | undefined, signal?: AbortSignal, onProgress?: AiProgressCallback): Promise<T> {
  const requestId = onProgress ? crypto.randomUUID() : undefined;
  const startedAt = Date.now();
  const timeout = AbortSignal.timeout(150000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const polling = new AbortController();
  let stopped = false, cancelled = false, lastNotice = '', receivedSnapshot = false;
  let submitted = false;
  let cancellationTask: Promise<void> | undefined;
  let releaseWait: (() => void) | undefined;
  function emit(update: AiRequestSnapshot | AiTrackingNotice) {
    if (!onProgress) return;
    try { onProgress(update); } catch { /* A UI callback cannot interrupt the actual AI request. */ }
  }
  function notice(message: string) {
    if (!requestId || message === lastNotice) return;
    lastNotice = message;
    emit({ id: requestId, notice: true, elapsedMs: Date.now() - startedAt, level: 'error', message });
  }
  function stopPolling() { stopped = true; polling.abort(); releaseWait?.(); }
  function abortError() {
    return new Error(signal?.aborted
      ? operation === 'organize' ? '已取消 AI 整理。' : '已取消连接测试。'
      : operation === 'organize' ? 'AI 整理超时，已请求停止后台处理。请查看处理记录后重试。' : 'AI 连接测试超时，已请求停止后台处理。请检查 API 地址和模型。');
  }
  async function readSnapshot(final = false) {
    if (!requestId) return;
    const readTimeout = AbortSignal.timeout(3000);
    try {
      const snapshot = await request<AiRequestSnapshot>(`/ai/requests/${encodeURIComponent(requestId)}`, { signal: final ? AbortSignal.any([combined, readTimeout]) : AbortSignal.any([polling.signal, readTimeout]) });
      if (cancelled || (!final && stopped)) return;
      receivedSnapshot = true; lastNotice = ''; emit(snapshot);
    } catch (error) {
      if (cancelled || (!final && stopped)) return;
      if (!final && error instanceof ApiError && error.status === 404 && !receivedSnapshot && Date.now() - startedAt < 3000) return;
      const detail = error instanceof ApiError ? `HTTP ${error.status}` : readTimeout.aborted ? '读取超时' : '连接失败';
      notice(final ? `请求已结束，但最后处理状态读取失败（${detail}）。请查看后台日志。` : `暂时无法读取处理记录（${detail}）。请求仍在等待响应，可查看后台日志。`);
    }
  }
  async function poll() {
    while (!stopped) {
      await readSnapshot();
      if (stopped) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { releaseWait = undefined; resolve(); }, 1000);
        releaseWait = () => { clearTimeout(timer); releaseWait = undefined; resolve(); };
      });
    }
  }
  const pollingTask = requestId ? poll() : Promise.resolve();
  function cancelUpstream() {
    if (cancellationTask) return cancellationTask;
    cancellationTask = (async () => {
      if (!requestId || !submitted) return;
      cancelled = true; stopPolling();
      const cancelDeadline = AbortSignal.timeout(3000);
      while (!cancelDeadline.aborted) {
        try {
          const snapshot = await request<AiRequestSnapshot>(`/ai/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', signal: cancelDeadline });
          emit(snapshot);
          if (snapshot.state === 'CANCELLED') return;
          if (snapshot.state !== 'RUNNING') { notice('后台处理已结束，但未返回取消确认。本次结果不会应用，请查看处理记录。'); return; }
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404) || cancelDeadline.aborted) break;
        }
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); cancelDeadline.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, 150);
          cancelDeadline.addEventListener('abort', finish, { once: true });
          if (cancelDeadline.aborted) finish();
        });
      }
      notice('取消已请求，但无法确认后台是否停止。请查看后台日志。');
    })();
    return cancellationTask;
  }
  const onAbort = () => { void cancelUpstream(); };
  combined.addEventListener('abort', onAbort, { once: true });
  const body = operation === 'organize' ? json({ statement: input, ...(requestId ? { requestId } : {}) }) : requestId ? json({ requestId }) : undefined;
  try {
    if (combined.aborted) throw combined.reason;
    submitted = true;
    const result = await request<T>(`/ai/${operation}`, { method: 'POST', ...(body ? { body } : {}), signal: combined });
    if (combined.aborted) throw combined.reason;
    return result;
  } catch (error) {
    if (signal?.aborted || timeout.aborted) await cancelUpstream();
    if (combined.aborted) throw abortError();
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请重启应用后重试。');
    if (error instanceof SyntaxError) throw new Error('本地服务返回了无法解析的响应，请查看后台日志。');
    throw error;
  } finally {
    stopPolling(); await pollingTask;
    if (requestId && !cancelled) await readSnapshot(true);
    if (cancellationTask) await cancellationTask;
    combined.removeEventListener('abort', onAbort);
    if (combined.aborted) throw abortError();
  }
}
export const api = {
  health: () => request<Health>('/health'),
  problems: () => request<ProblemSummary[]>('/problems'),
  problem: (id: string) => request<Problem>(`/problems/${encodeURIComponent(id)}`),
  create: (title: string) => request<Problem>('/problems', { method: 'POST', body: json({ title }) }),
  save: (problem: Problem) => request<Problem>(`/problems/${encodeURIComponent(problem.id)}`, { method: 'PUT', body: json(problem) }),
  remove: (id: string) => request<void>(`/problems/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  layout: () => request<Layout>('/settings/layout'),
  saveLayout: (layout: Layout) => request<Layout>('/settings/layout', { method: 'PUT', body: json(layout) }),
  aiSettings: (signal?: AbortSignal) => request<AiSettings>('/settings/ai', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }),
  saveAiSettings: (settings: AiSettingsUpdate, signal?: AbortSignal) => request<AiSettings>('/settings/ai', { method: 'PUT', body: json(settings), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }),
  testAiConnection: (signal?: AbortSignal, onProgress?: AiProgressCallback, thirdProgress?: AiProgressCallback) => aiOperation<{ message: string; model: string }>('test', undefined, signal, thirdProgress || onProgress),
  organizeStatement: (statement: string, signal?: AbortSignal, onProgress?: AiProgressCallback) => aiOperation<{ statement: string }>('organize', statement, signal, onProgress),
  runs: (id: string) => request<Job[]>(`/problems/${encodeURIComponent(id)}/runs`),
  run: (id: string) => request<Job>(`/runs/${encodeURIComponent(id)}`),
  start: (problemId: string, replaySeed?: string) => request<Job>('/jobs', { method: 'POST', body: json({ problemId, ...(replaySeed !== undefined ? { replaySeed } : {}) }) }),
  job: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}`),
  cancel: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  upload: async (file: File, signal?: AbortSignal) => {
    const form = new FormData(); form.append('file', file);
    const timeout = AbortSignal.timeout(30000);
    try {
      return await request<{ url: string }>('/images', { method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (error) {
      if (timeout.aborted) throw new Error('图片保存超时，请检查本地服务后重试。');
      if (signal?.aborted) throw new Error('已取消插入图片。');
      if (error instanceof TypeError) throw new Error('无法连接本地服务，图片未保存，请重启应用后重试。');
      throw error;
    }
  },
  recognitionStatus: (signal?: AbortSignal) => request<RecognitionStatus>('/images/recognition/status', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }),
  recognizeImage: async (url: string, language = '', signal?: AbortSignal, region?: { x: number; y: number; width: number; height: number }): Promise<OcrImage> => {
    const filename = url.match(/^\/api\/images\/([0-9a-f-]{36}\.png)$/)?.[1];
    if (!filename) throw new Error('请选择已保存到题面的本地图片。');
    const timeout = AbortSignal.timeout(65000);
    try {
      const result = await request<Omit<OcrImage, 'url'>>(`/images/${filename}/recognize`, { method: 'POST', body: json({ language, ...(region ? { region } : {}) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      return { ...result, url, ...(region ? { focused: true } : {}) };
    } catch (error) {
      if (signal?.aborted) throw new Error('已取消图片识别。');
      if (timeout.aborted) throw new Error('图片识别超时，请缩小图片或分成多张后重试。');
      if (error instanceof TypeError) throw new Error('无法连接本地服务，请重启应用后重试。');
      throw error;
    }
  },
  exportUrl: (id: string, kind: string) => `/api/runs/${encodeURIComponent(id)}/export/${kind}`,
};
