import type { GeneratedTestCase } from './api';
import type { TestCase } from './types';

/** Matches the backend limit on saved custom cases. */
export const MAX_CUSTOM_CASES = 50;

/** One editable row of the AI preview; an empty expected output means only brute and optimized are compared. */
export interface GeneratedDraft { key: string; category: string; input: string; expected: string; note: string }

export function toDrafts(cases: GeneratedTestCase[]): GeneratedDraft[] {
  return cases.map((value, index) => ({ key: `ai-${index}`, category: value.category, input: value.input, expected: value.expected ?? '', note: value.note }));
}

const normalized = (input: string) => input.replace(/\r\n/g, '\n').trimEnd();
/** Inputs that differ only in trailing whitespace run identically, so they count as the same case. */
export const hasInput = (cases: TestCase[], input: string) => cases.some(test => normalized(test.input) === normalized(input));

/** Appends drafts as AI custom cases, skipping blank inputs and inputs that already exist, within the case limit. */
export function importGeneratedCases(existing: TestCase[], drafts: GeneratedDraft[], newId: () => string) {
  const cases = [...existing], added: TestCase[] = [];
  let skipped = 0;
  for (const draft of drafts) {
    if (!draft.input.trim() || hasInput(cases, draft.input) || cases.length >= MAX_CUSTOM_CASES) { skipped++; continue; }
    const test: TestCase = { id: newId(), input: draft.input, expected: draft.expected.trim() ? draft.expected : '', source: 'ai', category: draft.category, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) };
    cases.push(test); added.push(test);
  }
  return { cases, added, skipped };
}
