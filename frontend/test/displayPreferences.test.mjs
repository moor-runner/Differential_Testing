import test from 'node:test';
import assert from 'node:assert/strict';
import { readDisplayPreferences, tabDestination, visiblePane, zoomFontSize } from '../src/displayPreferences.ts';

test('older saved layouts open on the optimized editor and keep pane sizes untouched', () => {
  const layout = { sidebar: [16, 84], workspace: [58, 42], editors: [30, 40, 30], uiMode: [1] };
  assert.deepEqual(readDisplayPreferences(layout), { activeTab: 2, fontSize: 14 });
  assert.deepEqual(layout.editors, [30, 40, 30]);
});
test('active editor and font size survive JSON roundtrip without changing pane sizes', () => {
  const layout = JSON.parse(JSON.stringify({ codeTab: [0], fontSize: [17], workspace: [58, 42], editors: [25, 50, 25] }));
  assert.deepEqual(readDisplayPreferences(layout), { activeTab: 0, fontSize: 17 });
  assert.deepEqual(layout.editors, [25, 50, 25]);
});
test('malformed display preferences cannot hide every editor or break text size', () => {
  for (const value of [null, '1', 1, [NaN], [-1], [3], [1.5], ['1'], [1, 2], [10], [25]]) {
    assert.deepEqual(readDisplayPreferences({ codeTab: value, fontSize: value }), { activeTab: 2, fontSize: 14 });
  }
});
test('font zoom is bounded and resets to the initial size', () => {
  assert.equal(zoomFontSize(14, '='), 15);
  assert.equal(zoomFontSize(14, '-'), 13);
  assert.equal(zoomFontSize(24, '+'), 24);
  assert.equal(zoomFontSize(11, '-'), 11);
  assert.equal(zoomFontSize(20, '0'), 14);
  assert.equal(zoomFontSize(14, 'a'), undefined);
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
