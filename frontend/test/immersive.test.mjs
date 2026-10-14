import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeSize, isEditingKey, peekAt } from '../src/immersive.ts';

const key = (value, modifiers = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...modifiers });

test('typing, deleting, Enter, Tab and IME composition count as editing', () => {
  for (const value of ['a', 'Z', '1', ' ', ';', '{', '中', 'Backspace', 'Delete', 'Enter', 'Tab', 'Process']) assert.equal(isEditingKey(key(value)), true, value);
  assert.equal(isEditingKey(key('Unidentified', { isComposing: true })), true);
  assert.equal(isEditingKey(key('A', { shiftKey: true })), true);
});
test('shortcuts, navigation, function keys and Escape do not hide the bars', () => {
  for (const value of ['ArrowUp', 'ArrowLeft', 'PageDown', 'Home', 'End', 'Escape', 'F2', 'F11', 'Shift', 'Control', 'Meta', 'Alt', 'CapsLock']) assert.equal(isEditingKey(key(value)), false, value);
  assert.equal(isEditingKey(key('s', { ctrlKey: true })), false);
  assert.equal(isEditingKey(key('Enter', { metaKey: true })), false);
  assert.equal(isEditingKey(key('1', { altKey: true })), false);
});
test('the top and bottom edges of the window reveal the matching bars', () => {
  assert.equal(peekAt(null, 0, 900, 0), 'top');
  assert.equal(peekAt(null, edgeSize - 1, 900, 0), 'top');
  assert.equal(peekAt(null, edgeSize, 900, 0), null);
  assert.equal(peekAt(null, 899, 900, 0), 'bottom');
  assert.equal(peekAt(null, 900 - edgeSize, 900, 0), null);
  assert.equal(peekAt(null, 450, 900, 0), null);
  assert.equal(peekAt('top', 899, 900, 84), 'bottom', '直接移到另一边缘时切换');
});
test('revealed bars stay while the pointer is over them and hide once it leaves', () => {
  assert.equal(peekAt('top', 60, 900, 84), 'top');
  assert.equal(peekAt('top', 84, 900, 84), 'top');
  assert.equal(peekAt('top', 85, 900, 84), null);
  assert.equal(peekAt('bottom', 870, 900, 866), 'bottom');
  assert.equal(peekAt('bottom', 600, 900, 566), 'bottom', '结果面板展开时，状态栏下方的结果区域也算在范围内');
  assert.equal(peekAt('bottom', 500, 900, 566), null);
  assert.equal(peekAt(null, 60, 900, 84), null, '未呼出时只有边缘热区生效');
});
