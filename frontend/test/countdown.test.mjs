import test from 'node:test';
import assert from 'node:assert/strict';
import { countdownRange, formatCountdown, parseCountdown, readCountdown } from '../src/countdown.ts';

test('plain numbers are minutes and colon forms are m:ss or h:mm:ss', () => {
  assert.equal(parseCountdown('90'), 90 * 60);
  assert.equal(parseCountdown(' 25 '), 25 * 60);
  assert.equal(parseCountdown('25:30'), 25 * 60 + 30);
  assert.equal(parseCountdown('0:45'), 45);
  assert.equal(parseCountdown('1:30:00'), 90 * 60);
  assert.equal(parseCountdown('2：05：09'), 2 * 3600 + 5 * 60 + 9);
});
test('malformed, empty or out-of-range durations are rejected', () => {
  for (const text of ['', ' ', '0', '0:00', 'abc', '1.5', '-5', '1:60', '1:00:60', '1:2:3:4', '25:', ':30', '1441', '24:00:01']) {
    assert.equal(parseCountdown(text), undefined, text);
  }
  assert.equal(parseCountdown('24:00:00'), countdownRange.max);
});
test('remaining time shows hours only when needed and never goes negative', () => {
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(-3), '00:00');
  assert.equal(formatCountdown(59.2), '01:00');
  assert.equal(formatCountdown(25 * 60), '25:00');
  assert.equal(formatCountdown(3599), '59:59');
  assert.equal(formatCountdown(3600), '1:00:00');
  assert.equal(formatCountdown(5 * 3600 + 7 * 60 + 3), '5:07:03');
});
test('saved duration survives JSON roundtrip and malformed values fall back to the default', () => {
  assert.equal(readCountdown(JSON.parse(JSON.stringify({ countdown: [5400] }))), 5400);
  assert.equal(readCountdown({}), countdownRange.initial);
  for (const value of [null, 60, [0], [1.5], ['60'], [60, 60], [countdownRange.max + 1]]) {
    assert.equal(readCountdown({ countdown: value }), countdownRange.initial);
  }
});
