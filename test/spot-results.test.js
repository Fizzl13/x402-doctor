// The latest spot-buy on the Trust Index: /api/trust/spot, spot_buy in /api/trust, and the loader behind them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpotResults, viewOf } = require('../lib/spot-results');
const { createTrustIndex } = require('../lib/trust-index');

const report = {
  date: '2026-10-12', index_date: '2026-10-12', rules: { n: 30, cap_usd: 0.05 }, wallet: '0x' + 'a'.repeat(40),
  summary: { live: true, sampled: 3, bought: 2, outcomes: { delivered: 1, charged_not_delivered: 1 }, paid_and_delivered_pct: 50, charged_without_answer: { count: 1, usd: 0.01 }, spent_usd: 0.02 },
  results: [
    { url: 'https://a.example/v1/price', host: 'a.example', step: 'paid', result: 'delivered', price_usd: 0.01, charged_usd: 0.01, status: 200, request: { source: 'example' }, proof: { overall: 'pass', explorer: 'https://basescan.org/tx/0x1' }, preflight: { verdict: 'go' } },
    { url: 'https://b.example/run', host: 'b.example', step: 'paid', result: 'charged_not_delivered', price_usd: 0.01, charged_usd: 0.01, status: 422, reason: 'missing json_schema', request: { source: 'plain' }, proof: null, ms: 1234 },
    { url: 'https://c.example/x', host: 'c.example', step: 'probe', result: 'not_402_now' },
  ],
};
const serve = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('viewOf: the summary and only the purchases, without the wallet; dry runs are not shown', () => {
  const v = viewOf(report);
  assert.equal(v.date, '2026-10-12');
  assert.equal(v.summary.paid_and_delivered_pct, 50);
  assert.deepEqual(v.purchases.map((p) => [p.host, p.result, p.request]), [['a.example', 'delivered', 'example'], ['b.example', 'charged_not_delivered', 'plain']]);
  assert.equal(v.purchases[0].explorer, 'https://basescan.org/tx/0x1');
  assert.equal(v.purchases[1].reason, 'missing json_schema');
  assert.equal(v.purchases[1].answer_s, 1.2, 'answer time in seconds');
  assert.equal(v.purchases[0].answer_s, null, 'no time measured');
  assert.equal(JSON.stringify(v).includes('aaaa'), false, 'the wallet address is left out');
  assert.equal(viewOf({ ...report, summary: { ...report.summary, live: false } }), null);
});

test('createSpotResults: latest run and per-URL lookup (path match, query and trailing slash ignored); unknown when unavailable', async () => {
  const spot = createSpotResults({ url: 'http://spot.test', fetchImpl: serve(report) });
  assert.equal((await spot.latest({ waitMs: 1000 })).summary.bought, 2);
  assert.equal((await spot.forUrl('https://b.example/run/?x=1')).result, 'charged_not_delivered');
  assert.equal(await spot.forUrl('https://c.example/x'), null, 'skipped before paying = not bought');
  const down = createSpotResults({ url: 'http://spot.test', fetchImpl: serve({}, 404) });
  assert.equal(await down.latest({ waitMs: 1000 }), null);
});

test('GET /api/trust/spot and spot_buy in GET /api/trust', async (t) => {
  const { createApp } = require('../server.js');
  const index = { updated: '2026-10-12T03:30:00Z', days: ['2026-10-11', '2026-10-12'], resources: { 'https://b.example/run': { url: 'https://b.example/run', m: 'POST', h: 'gg', last: { verdict: 'go', price_usd: 0.01 } } } };
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, trustIndex: createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl: serve(index) }), spotResults: createSpotResults({ url: 'http://spot.test', fetchImpl: serve(report) }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const latest = await (await fetch(`${base}/api/trust/spot`)).json();
  assert.equal(latest.summary.paid_and_delivered_pct, 50);
  assert.equal(latest.purchases.length, 2);
  const one = await (await fetch(`${base}/api/trust?url=${encodeURIComponent('https://b.example/run')}`)).json();
  assert.equal(one.days_checked, 2);
  assert.equal(one.spot_buy.result, 'charged_not_delivered');
  assert.equal(one.spot_buy.date, '2026-10-12');
  const page = await (await fetch(`${base}/trust`)).text();
  assert.match(page, /Paid and delivered\?/);
  assert.match(page, /\/api\/trust\/spot/);
});

test('GET /api/trust/spot answers 503 while nothing is loaded', async (t) => {
  const { createApp } = require('../server.js');
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, spotResults: createSpotResults({ url: 'http://spot.test', fetchImpl: serve({}, 500) }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/trust/spot`)).status, 503);
});
