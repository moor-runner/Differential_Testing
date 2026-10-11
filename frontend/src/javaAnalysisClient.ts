import type { JavaAnalysis, JavaOperation } from './javaIntelligence.ts';

export class JavaAnalysisError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Java analysis unavailable (${status})`); this.status = status; }
}

interface PendingRequest { controller: AbortController; promise: Promise<JavaAnalysis>; result?: JavaAnalysis }
interface PendingCompletion extends PendingRequest { context: string; prefix: string }

/** One model's bounded cache. Invalidating a version aborts all old work. */
export class JavaAnalysisClient {
  private version = -1;
  private requests = new Map<string, PendingRequest>();
  private completion?: PendingCompletion;
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
      const entry: PendingRequest = { controller, promise: Promise.resolve(undefined as unknown as JavaAnalysis) };
      entry.promise = this.post(source, operation, offset, controller, () => this.version !== version).then(analysis => {
        entry.result = analysis;
        return analysis;
      }, error => {
        if (this.requests.get(key) === entry) this.requests.delete(key);
        throw error;
      });
      pending = entry;
      this.requests.set(key, entry);
    }
    return this.consume(pending.promise, signal);
  }

  /**
   * Completion results stay valid while the user keeps typing the same identifier: the backend
   * returns a superset for the typed prefix and Monaco filters it. Edits therefore never cancel
   * this request; it is shared until the text around the identifier changes.
   */
  complete(source: string, wordStart: number, wordEnd: number, offset: number, signal?: AbortSignal): Promise<JavaAnalysis> {
    if (this.disposed || signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    const context = `${source.slice(0, wordStart)}\u0000${source.slice(wordEnd)}`, prefix = source.slice(wordStart, offset);
    let pending = this.completion;
    // A list cut at the server's cap is no superset: a longer prefix needs its own request.
    const covers = pending && (prefix === pending.prefix || prefix.startsWith(pending.prefix) && !pending.result?.incomplete);
    if (!pending || pending.controller.signal.aborted || pending.context !== context || !covers) {
      pending?.controller.abort();
      const controller = new AbortController();
      const entry: PendingCompletion = { controller, context, prefix, promise: Promise.resolve(undefined as unknown as JavaAnalysis) };
      entry.promise = this.post(source, 'complete', offset, controller, () => false).then(analysis => {
        entry.result = analysis;
        return analysis;
      }, error => {
        if (this.completion === entry) this.completion = undefined;
        throw error;
      });
      pending = entry;
      this.completion = entry;
    }
    return this.consume(pending.promise, signal);
  }

  private async post(source: string, operation: JavaOperation, offset: number | undefined, controller: AbortController, stale: () => boolean): Promise<JavaAnalysis> {
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      // Browser fetch is a platform method: a client object is not a valid receiver.
      const transport = this.transport;
      const response = await transport('/api/editor/java/analyze', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, operation, ...(offset === undefined ? {} : { offset }) }), signal: controller.signal,
      });
      if (!response.ok) throw new JavaAnalysisError(response.status);
      const analysis = await response.json() as JavaAnalysis;
      if (controller.signal.aborted || this.disposed || stale()) throw new DOMException('Cancelled', 'AbortError');
      return analysis;
    } finally { clearTimeout(timeout); }
  }

  /** A cancelled consumer (for example a hover) must not cancel shared work. */
  private consume(promise: Promise<JavaAnalysis>, signal?: AbortSignal): Promise<JavaAnalysis> {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      const cleanup = () => signal.removeEventListener('abort', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      promise.then(value => { cleanup(); if (!signal.aborted) resolve(value); }, error => { cleanup(); if (!signal.aborted) reject(error); });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const request of this.requests.values()) request.controller.abort();
    this.requests.clear();
    this.completion?.controller.abort();
    this.completion = undefined;
  }
}
