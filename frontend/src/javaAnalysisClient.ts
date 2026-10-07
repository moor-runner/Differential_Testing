import type { JavaAnalysis, JavaOperation } from './javaIntelligence.ts';

export class JavaAnalysisError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Java analysis unavailable (${status})`); this.status = status; }
}

interface PendingRequest { controller: AbortController; promise: Promise<JavaAnalysis>; result?: JavaAnalysis }

/** One model's bounded cache. Invalidating a version aborts all old work. */
export class JavaAnalysisClient {
  private version = -1;
  private requests = new Map<string, PendingRequest>();
  private disposed = false;
  private transport: typeof fetch;

  constructor(transport: typeof fetch = fetch) { this.transport = transport; }

  invalidate(version: number): void {
    if (version === this.version) return;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.version = version;
  }

  peek(version: number, operation: JavaOperation, offset?: number): JavaAnalysis | undefined {
    if (this.disposed || version !== this.version) return undefined;
    return this.requests.get(`${operation}:${offset ?? ''}`)?.result;
  }

  request(source: string, version: number, operation: JavaOperation, offset?: number, signal?: AbortSignal): Promise<JavaAnalysis> {
    if (this.disposed || signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    this.invalidate(version);
    const key = `${operation}:${offset ?? ''}`;
    let pending = this.requests.get(key);
    if (!pending || pending.controller.signal.aborted) {
      // Keep a small cache for repeated hover/definition at the same cursor.
      if (this.requests.size >= 24) {
        const oldestKey = this.requests.keys().next().value!;
        this.requests.get(oldestKey)?.controller.abort();
        this.requests.delete(oldestKey);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      pending = { controller, promise: Promise.resolve(undefined as unknown as JavaAnalysis) };
      const entry = pending;
      entry.promise = (async () => {
        try {
          // Browser fetch is a platform method: a client object is not a valid receiver.
          const transport = this.transport;
          const response = await transport('/api/editor/java/analyze', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source, operation, ...(offset === undefined ? {} : { offset }) }), signal: controller.signal,
          });
          if (!response.ok) throw new JavaAnalysisError(response.status);
          const analysis = await response.json() as JavaAnalysis;
          if (controller.signal.aborted || this.disposed || this.version !== version) throw new DOMException('Cancelled', 'AbortError');
          entry.result = analysis;
          return analysis;
        } catch (error) {
          if (this.requests.get(key) === entry) this.requests.delete(key);
          throw error;
        } finally { clearTimeout(timeout); }
      })();
      this.requests.set(key, entry);
    }
    if (!signal) return pending.promise;
    // A cancelled hover consumer must not cancel a shared definition request.
    return new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      const cleanup = () => signal.removeEventListener('abort', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      pending!.promise.then(value => { cleanup(); if (!signal.aborted) resolve(value); }, error => { cleanup(); if (!signal.aborted) reject(error); });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
  }
}
