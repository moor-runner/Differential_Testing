import test from 'node:test';
import assert from 'node:assert/strict';
import { fitImageSize } from '../src/imageSize.ts';

test('small image keeps its original resolution', () => {
  assert.deepEqual(fitImageSize({ width: 320, height: 180 }, { width: 1400, height: 700 }), { width: 320, height: 180, scale: 1 });
});
test('large landscape image fits both viewport bounds without stretching', () => {
  const fit = fitImageSize({ width: 3840, height: 2160 }, { width: 1400, height: 700 });
  assert.equal(fit.height, 700); assert.ok(fit.width <= 1400);
  assert.equal(fit.width / fit.height, 3840 / 2160);
});
test('portrait image refits when the window gets smaller', () => {
  const image = { width: 800, height: 4000 };
  const large = fitImageSize(image, { width: 1200, height: 800 });
  const small = fitImageSize(image, { width: 900, height: 480 });
  assert.equal(large.height, 800); assert.equal(small.height, 480);
  assert.equal(small.width, 96); assert.ok(small.scale < large.scale);
});
