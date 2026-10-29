import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceDrink, createDrink, isDrinkingTilt, isNearMouth } from '../src/sip.js';

test('a held, tilted cup at the mouth drains and counts one continuous sip', () => {
  const input = { held: true, nearMouth: true, tilted: true, deltaSeconds: 0.1 };
  const first = advanceDrink(createDrink(), input);
  const second = advanceDrink(first, input);
  assert.ok(Math.abs(second.fill - 0.94) < 1e-10);
  assert.equal(second.sips, 1);
  const paused = advanceDrink(second, { ...input, nearMouth: false });
  assert.equal(advanceDrink(paused, input).sips, 2);
});

test('a cup must be held, near the mouth, and tilted to drain', () => {
  for (const missing of ['held', 'nearMouth', 'tilted']) {
    const result = advanceDrink(createDrink(), {
      held: true, nearMouth: true, tilted: true, deltaSeconds: 0.1, [missing]: false,
    });
    assert.equal(result.fill, 1);
    assert.equal(result.sips, 0);
  }
});

test('draining stops at empty and long frame pauses cannot empty a cup instantly', () => {
  const input = { held: true, nearMouth: true, tilted: true, deltaSeconds: 10 };
  assert.equal(advanceDrink(createDrink(), input).fill, 0.97);
  const empty = advanceDrink({ fill: 0.01, sips: 1, sipping: true }, input);
  assert.equal(empty.fill, 0);
  assert.equal(advanceDrink(empty, input).sipping, false);
  assert.equal(advanceDrink(empty, input).sips, 1);
});

test('invalid elapsed times surface an error', () => {
  for (const deltaSeconds of [-1, NaN, Infinity]) {
    assert.throws(() => advanceDrink(createDrink(), { deltaSeconds }), RangeError);
  }
});

test('mouth proximity is three-dimensional and a sensible tilt is required', () => {
  const mouth = { x: 1, y: 1.5, z: -1 };
  assert.equal(isNearMouth({ x: 1.05, y: 1.45, z: -1.05 }, mouth), true);
  assert.equal(isNearMouth({ x: 1, y: 1.8, z: -1 }, mouth), false);
  assert.equal(isDrinkingTilt(1), false);
  assert.equal(isDrinkingTilt(Math.cos(Math.PI / 4)), true);
  assert.equal(isDrinkingTilt(-1), false);
});
