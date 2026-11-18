// lib/atlas-slim.js: the star map atlas.fizzl.eu draws, with at most perSeller dust particles for one seller and the
// exact counts beside the sample.
const test = require('node:test');
const assert = require('node:assert/strict');
const { slimAtlas } = require('../lib/atlas-slim');

function map() {
  const endpoints = [];
  // seller 0: 10 endpoints, two of them bait; seller 1: 2 endpoints.
  for (let i = 0; i < 10; i++) endpoints.push(i === 3 || i === 8 ? [0, i < 5 ? 'gn' : 'c-', 1] : [0, i < 5 ? 'gn' : 'c-']);
  endpoints.push([1, 'xg'], [1, '-g']);
  return { days: ['2026-11-17', '2026-11-18'], sellers: [['big.example', 0, 10, 2], ['small.example', 0, 2, 0]], endpoints };
}

test('a seller over the cap keeps its bait plus an even sample, and its exact counts', () => {
  const full = map();
  const slim = slimAtlas(full, { perSeller: 4 });
  const big = slim.endpoints.filter((e) => e[0] === 0);
  assert.equal(big.length, 4);
  assert.equal(big.filter((e) => e[2]).length, 2, 'both bait endpoints stay');
  assert.equal(slim.endpoints.filter((e) => e[0] === 1).length, 2, 'a seller under the cap keeps everything');
  assert.equal(slim.endpoints_total, 12);
  // Day 0: five "g" + five "c" from seller 0, one "x" from seller 1. Day 1: five "n" from seller 0, two "g" from seller 1.
  assert.deepEqual(slim.day_totals, [[5, 5, 0, 1], [2, 0, 5, 0]]);
  assert.deepEqual(slim.seller_days, [[0, [[5, 5, 0, 0], [0, 0, 5, 0]]]]);
  assert.equal(full.endpoints.length, 12, 'the full map is left as it is');
});

test('the same endpoints are kept on every build, and nothing changes under the cap', () => {
  assert.deepEqual(slimAtlas(map(), { perSeller: 4 }).endpoints, slimAtlas(map(), { perSeller: 4 }).endpoints);
  const same = slimAtlas(map(), { perSeller: 1000 });
  assert.equal(same.endpoints.length, 12);
  assert.deepEqual(same.seller_days, []);
  assert.equal(slimAtlas(null), null);
});
