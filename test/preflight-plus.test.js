// Batch and deep preflight (lib/preflight-plus.js) and the seller summary of the trust index.

const test = require('node:test');
const assert = require('node:assert/strict');
const { batchPreflight, deepPreflight, dailyHistory } = require('../lib/preflight-plus');
const { createTrustIndex } = require('../lib/trust-index');

const verdictFor = (url) => ({ url, verdict: 'go', safe_to_pay: true, summary: 'OK to pay: $0.01 on Base.', recommended_option: 0, options: [], reasons: [], signals: {} });

test('batch: an endpoint that hangs is "unknown" and does not hold up the rest', async () => {
  const runPreflight = (url) => (url.includes('slow') ? new Promise(() => {}) : Promise.resolve(verdictFor(url)));
  const out = await batchPreflight(['https://a.example/paid', 'https://slow.example/paid'], { runPreflight, timeoutMs: 50 });
  assert.deepEqual(out.results.map((r) => r.verdict), ['go', 'unknown']);
  assert.match(out.results[1].error, /no answer within/);
  assert.deepEqual(out.counts, { go: 1, caution: 0, no_go: 0, unknown: 1 });
});

test('batch: at least one and at most 10 distinct urls', async () => {
  const runPreflight = async (url) => verdictFor(url);
  await assert.rejects(batchPreflight([], { runPreflight }), /at least one/);
  await assert.rejects(batchPreflight(Array.from({ length: 11 }, (_, i) => `https://e.example/${i}`), { runPreflight }), /at most 10/);
  assert.equal((await batchPreflight(Array(12).fill('https://e.example/x'), { runPreflight })).count, 1, 'duplicates count once');
});

test('daily history: letters mapped to dates from the end of days[]; unscanned days left out', () => {
  assert.deepEqual(dailyHistory({ history: '-gcnx', days: ['d0', 'd1', 'd2', 'd3', 'd4', 'd5'] }), [
    { date: 'd2', status: 'go' },
    { date: 'd3', status: 'caution' },
    { date: 'd4', status: 'no_go' },
    { date: 'd5', status: 'unreachable' },
  ]);
  assert.deepEqual(dailyHistory(null), []);
});

test('deep: a seller whose endpoints were mostly not payable turns go into caution; a failed diagnosis does not break the answer', async () => {
  const out = await deepPreflight('https://s.example/paid', {
    runPreflight: async (url) => verdictFor(url),
    diagnose: async () => { throw new Error('boom'); },
    trustIndex: { lookup: async () => null, seller: async () => ({ origin: 'https://s.example', resources: 5, payable_now: 1, avg_payable_ratio: 0.3, unreliable: 4 }) },
  });
  assert.equal(out.verdict, 'caution');
  assert.equal(out.safe_to_pay, true);
  assert.match(out.summary, /30%/);
  assert.equal(out.diagnosis.error, 'boom');
});

test('trust index: seller() sums up the other resources on the same origin', async () => {
  const index = {
    days: ['d1', 'd2', 'd3'],
    resources: {
      'https://s.example/a': { h: 'ggg' },
      'https://s.example/b': { h: 'nnn' },
      'https://s.example/c': { h: '-gn' },
      'https://s.example.evil/a': { h: 'ggg' },
      'https://other.example/a': { h: 'ggg' },
    },
  };
  const trust = createTrustIndex({ url: 'http://index', fetchImpl: async () => ({ ok: true, json: async () => index }) });
  await trust.refresh();
  const s = await trust.seller('https://s.example/a?x=1');
  assert.deepEqual(s, { origin: 'https://s.example', resources: 3, payable_now: 1, avg_payable_ratio: 0.5, unreliable: 1 });
  assert.deepEqual(await trust.seller('https://unknown.example/x'), { origin: 'https://unknown.example', resources: 0 });
});
