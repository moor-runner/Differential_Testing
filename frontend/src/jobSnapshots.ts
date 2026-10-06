import type { Job } from './types';

const stateOrder = { COMPILING: 0, RUNNING: 1, FINISHED: 2 };

/** HTTP replies and SSE events can arrive out of order; terminal state is sticky. */
export function advanceSnapshot(current: Job | null, incoming: Job, expectedJobId?: string): Job | null {
  if (expectedJobId && (incoming.id !== expectedJobId || current?.id !== expectedJobId)) return current;
  if (!current || current.id !== incoming.id) return incoming;
  if (current.state === 'FINISHED') return current;
  if (incoming.state === 'FINISHED') return incoming;
  if (stateOrder[incoming.state] < stateOrder[current.state]) return current;
  if (incoming.elapsedMs < current.elapsedMs || incoming.completed < current.completed) return current;
  return incoming;
}
