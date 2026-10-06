import type { Health, Job, Layout, Problem, ProblemSummary } from './types';

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
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
export const api = {
  health: () => request<Health>('/health'),
  problems: () => request<ProblemSummary[]>('/problems'),
  problem: (id: string) => request<Problem>(`/problems/${encodeURIComponent(id)}`),
  create: (title: string) => request<Problem>('/problems', { method: 'POST', body: json({ title }) }),
  save: (problem: Problem) => request<Problem>(`/problems/${encodeURIComponent(problem.id)}`, { method: 'PUT', body: json(problem) }),
  remove: (id: string) => request<void>(`/problems/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  layout: () => request<Layout>('/settings/layout'),
  saveLayout: (layout: Layout) => request<Layout>('/settings/layout', { method: 'PUT', body: json(layout) }),
  runs: (id: string) => request<Job[]>(`/problems/${encodeURIComponent(id)}/runs`),
  run: (id: string) => request<Job>(`/runs/${encodeURIComponent(id)}`),
  start: (problemId: string, replaySeed?: string) => request<Job>('/jobs', { method: 'POST', body: json({ problemId, ...(replaySeed !== undefined ? { replaySeed } : {}) }) }),
  job: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}`),
  cancel: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  upload: async (file: File) => { const form = new FormData(); form.append('file', file); return request<{ url: string }>('/images', { method: 'POST', body: form }); },
  exportUrl: (id: string, kind: string) => `/api/runs/${encodeURIComponent(id)}/export/${kind}`,
};
