import test from 'node:test';
import assert from 'node:assert/strict';
import { readDisplayPreferences, tabDestination, visiblePane } from '../src/displayPreferences.ts';

test('older saved split sizes retain original display mode and remain untouched', () => {
  const layout = { sidebar: [16, 84], workspace: [58, 42], editors: [30, 40, 30] };
  assert.deepEqual(readDisplayPreferences(layout), { mode: 'split', activeTab: 0 });
  assert.deepEqual(layout.editors, [30, 40, 30]);
});
test('mode and active editor survive JSON roundtrip without changing pane sizes', () => {
  const layout = JSON.parse(JSON.stringify({ uiMode: [1], codeTab: [2], workspace: [58, 42], editors: [25, 50, 25] }));
  assert.deepEqual(readDisplayPreferences(layout), { mode: 'tabs', activeTab: 2 });
  layout.uiMode = [0];
  assert.deepEqual(readDisplayPreferences(layout), { mode: 'split', activeTab: 2 });
  assert.deepEqual(layout.editors, [25, 50, 25]);
});
test('malformed display preferences cannot hide every editor', () => {
  for (const value of [null, '1', 1, [NaN], [-1], [3], [1.5], ['1'], [1, 2]]) {
    assert.deepEqual(readDisplayPreferences({ uiMode: value, codeTab: value }), { mode: 'split', activeTab: 0 });
  }
});
test('tab keyboard navigation wraps and Home/End selects deterministic editor', () => {
  assert.equal(tabDestination(2, 'ArrowRight'), 0);
  assert.equal(tabDestination(0, 'ArrowLeft'), 2);
  assert.equal(tabDestination(1, 'Home'), 0);
  assert.equal(tabDestination(1, 'End'), 2);
  assert.equal(tabDestination(1, 'Enter'), undefined);
});
test('active pane filters only valid indices and leaves split mode ratios untouched', () => {
  assert.equal(visiblePane(0, 2), 0);
  assert.equal(visiblePane(2, 3), 2);
  for (const index of [undefined, NaN, -1, 3, 1.5]) assert.equal(visiblePane(index, 3), undefined);
});
