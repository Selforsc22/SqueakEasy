// node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kingOf, MIN_SCORES } from './map-logic.js';

const places = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('no crown until something clears the score floor', () => {
  assert.equal(kingOf(places, {}), null);
  assert.equal(kingOf(places, { a: { avg: 5, count: MIN_SCORES - 1 } }), null);
});

test('highest average wins', () => {
  const king = kingOf(places, {
    a: { avg: 3.1, count: 10 },
    b: { avg: 4.8, count: 3 },
    c: { avg: 4.2, count: 40 }
  });
  assert.equal(king.id, 'b');
  assert.equal(king.count, 3);
});

test('a tied average breaks on sample size', () => {
  const king = kingOf(places, { a: { avg: 4.5, count: 4 }, b: { avg: 4.5, count: 19 } });
  assert.equal(king.id, 'b');
});

test('a full tie keeps the incumbent, so the crown does not flicker', () => {
  const scores = { a: { avg: 4.5, count: 7 }, b: { avg: 4.5, count: 7 } };
  assert.equal(kingOf(places, scores).id, 'a');
  assert.equal(kingOf(places, scores).id, 'a');
});

test('junk input does not throw', () => {
  assert.equal(kingOf(null, {}), null);
  assert.equal(kingOf(places, null), null);
  assert.equal(kingOf([null, undefined, { id: 'a' }], { a: { avg: NaN, count: 9 } }), null);
});
