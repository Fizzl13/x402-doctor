// Price check (lib/jev-price.js): off without a key or a Trust Index, Jev picks the comparable candidates, the
// median of their prices is the comparison, reasons by ratio and absolute gap, cheaper alternatives named, cached,
// and nothing when Jev fails or too few services compare. Plus the Trust Index candidate search it relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPriceCheck, priceReason, marketPriceCheck, median } = require('../lib/jev-price');
const { createTrustIndex, wordsOf } = require('../lib/trust-index');

const quiet = { warn() {} };
const cands = (prices) => prices.map((p, i) => ({ url: `https://s${i}.example/api`, host: `s${i}.example`, description: `service ${i}`, price_usd: p }));
const index = (list) => ({ similar: async () => list });
const jev = (probs, status = 200) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (status !== 200) return new Response('{}', { status });
    return Response.json({ answers: Object.fromEntries(probs.map((p, i) => [`c${i}`, { type: 'noul', noul: p }])) });
  };
  return { fetch, calls };
};

test('median: odd and even', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('price check: off without a key or a Trust Index', () => {
  assert.equal(createPriceCheck({ apiKey: '', trustIndex: index([]) }).enabled, false);
  assert.equal(createPriceCheck({ apiKey: 'k' }).enabled, false);
  assert.equal(createPriceCheck({ apiKey: 'k', trustIndex: index([]) }).enabled, true);
});

test('price check: only the services Jev calls the same kind count; median, ratio and cheaper ones', async () => {
  // Six candidates; Jev rejects the $9 one, so it neither pulls the median up nor shows as an alternative.
  const list = cands([0.01, 0.02, 9, 0.01, 0.03, 0.005]);
  const j = jev([0.9, 0.8, 0.1, 0.95, 0.75, 0.9]);
  const pc = createPriceCheck({ apiKey: 'k', trustIndex: index(list), fetch: j.fetch, log: quiet });
  const r = await pc.compare('https://pricey.example/api', { description: 'Token safety check', priceUsd: 0.5 });
  assert.equal(r.comparables, 5);
  assert.equal(r.comparable_median_usd, 0.01);
  assert.equal(r.ratio, 50);
  assert.deepEqual(r.cheaper.map((c) => c.price_usd), [0.005, 0.01, 0.01]);
  assert.deepEqual(r.range_usd, [0.005, 0.03]);
  // One request, the target in the state, one yes/no question per candidate.
  assert.equal(j.calls.length, 1);
  assert.deepEqual(j.calls[0].state, { target: { host: 'pricey.example', description: 'Token safety check' } });
  assert.equal(Object.keys(j.calls[0].questions).length, 6);
  assert.equal(j.calls[0].questions.c2.type, 'noul');
  assert.equal(j.calls[0].questions.c2.instructions.candidate.host, 's2.example');
  // Cached per description: another price for the same service asks nothing new.
  const again = await pc.compare('https://pricey.example/api', { description: 'Token safety check', priceUsd: 0.02 });
  assert.equal(j.calls.length, 1);
  assert.equal(again.ratio, 2);
});

test('price check: nothing without a price, a description, enough candidates or enough comparable ones', async () => {
  const j = jev([0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
  const pc = createPriceCheck({ apiKey: 'k', trustIndex: index(cands([1, 1, 1, 1, 1, 1])), fetch: j.fetch, log: quiet });
  assert.equal(await pc.compare('https://a.example/x', { description: 'x', priceUsd: 0 }), null);
  assert.equal(await pc.compare('https://a.example/x', { description: '', priceUsd: 1 }), null);
  assert.equal(j.calls.length, 0);
  const few = createPriceCheck({ apiKey: 'k', trustIndex: index(cands([1, 1, 1, 1])), fetch: j.fetch, log: quiet });
  assert.equal(await few.compare('https://a.example/x', { description: 'x', priceUsd: 1 }), null);
  assert.equal(j.calls.length, 0, 'too few candidates: Jev is not asked');
  const unlike = createPriceCheck({ apiKey: 'k', trustIndex: index(cands([1, 1, 1, 1, 1, 1])), fetch: jev([0.9, 0.9, 0.9, 0.9, 0.2, 0.6]).fetch, log: quiet });
  assert.equal(await unlike.compare('https://a.example/x', { description: 'x', priceUsd: 1 }), null, 'only 4 comparable');
});

test('price check: nothing when Jev fails or answers incompletely', async () => {
  const list = cands([1, 1, 1, 1, 1, 1]);
  assert.equal(await createPriceCheck({ apiKey: 'k', trustIndex: index(list), fetch: jev([], 529).fetch, log: quiet }).compare('https://a.example/x', { description: 'x', priceUsd: 1 }), null);
  assert.equal(await createPriceCheck({ apiKey: 'k', trustIndex: index(list), fetch: jev([0.9]).fetch, log: quiet }).compare('https://a.example/x', { description: 'x', priceUsd: 1 }), null);
  const throws = async () => { throw new Error('down'); };
  assert.equal(await createPriceCheck({ apiKey: 'k', trustIndex: index(list), fetch: throws, log: quiet }).compare('https://a.example/x', { description: 'x', priceUsd: 1 }), null);
});

test('priceReason: caution from 20x and $0.25 more, info from 5x and $0.05 more, quiet for cent-level gaps', () => {
  const cmp = (price, mid) => ({ price_usd: price, comparable_median_usd: mid, comparables: 8, ratio: Math.round((price / mid) * 10) / 10, cheaper: [] });
  assert.equal(priceReason(null), null);
  assert.equal(priceReason(cmp(0.5, 0.01)).level, 'caution');
  assert.equal(priceReason(cmp(0.2, 0.01)).level, 'info', '20x but only $0.19 more');
  assert.equal(priceReason(cmp(0.1, 0.02)).level, 'info');
  assert.equal(priceReason(cmp(0.005, 0.001)), null, '5x but a fraction of a cent');
  assert.equal(priceReason(cmp(0.03, 0.02)), null);
  assert.match(priceReason(cmp(0.5, 0.01)).message, /TypeSafe Jev/);
  assert.doesNotMatch(priceReason(cmp(0.5, 0.01)).message, /Cheaper alternatives/);
});

test('trust index similar: rare shared words rank first, the target seller and unpayable or unpriced APIs left out, two per seller', async () => {
  const entry = (url, d, price, verdict = 'go') => [url, { url, d, h: 'g', last: { verdict, price_usd: price, networks: ['eip155:8453'] } }];
  const resources = Object.fromEntries([
    entry('https://own.example/other', 'Ichimoku cloud crypto signal', 0.02),
    entry('https://a.example/1', 'Ichimoku cloud crypto signal for a pair', 0.05),
    entry('https://a.example/2', 'Ichimoku cloud crypto signal, hourly', 0.05),
    entry('https://a.example/3', 'Ichimoku cloud crypto signal, daily', 0.05),
    entry('https://b.example/1', 'Crypto price feed', 0.01),
    entry('https://c.example/1', 'Ichimoku cloud signal', 0.1, 'no_go'),
    entry('https://d.example/1', 'Ichimoku cloud signal', null),
    ...Array.from({ length: 20 }, (_, i) => entry(`https://f${i}.example/x`, `Weather forecast for city ${i}`, 0.01)),
  ]);
  const ti = createTrustIndex({ fetchImpl: async () => Response.json({ updated: 'now', days: ['d'], resources }) });
  await ti.refresh();
  const s = await ti.similar('https://own.example/signal', 'Ichimoku cloud signal for a crypto pair');
  assert.deepEqual(s.map((x) => x.url), ['https://a.example/1', 'https://a.example/2', 'https://b.example/1']);
  assert.equal(s[0].price_usd, 0.05);
  assert.deepEqual(await ti.similar('https://own.example/signal', 'the api for agents'), []);
  assert.deepEqual([...wordsOf('The Ichimoku API for agents, x402')], ['ichimoku']);
});

test('marketPriceCheck: always info; says where the price sits; a hint only when far off either way', () => {
  const cmp = (price, mid, cheaper = []) => ({ price_usd: price, comparable_median_usd: mid, comparables: 7, ratio: Math.round((price / mid) * 10) / 10, range_usd: [0.001, 0.05], cheaper });
  assert.equal(marketPriceCheck(null), null);
  const high = marketPriceCheck(cmp(0.5, 0.01, [{ url: 'https://a.example/x', price_usd: 0.005 }]));
  assert.equal(high.status, 'info');
  assert.match(high.message, /\$0\.5 is 50x the median of \$0\.01 across 7 comparable/);
  assert.match(high.message, /\$0\.001 to \$0\.05/);
  assert.match(high.hint, /a\.example\/x at \$0\.005/);
  const same = marketPriceCheck(cmp(0.02, 0.02));
  assert.match(same.message, /in line with the median of \$0\.02/);
  assert.equal(same.hint, undefined);
  assert.match(marketPriceCheck(cmp(0.01, 0.02)).message, /below the median of \$0\.02/);
  assert.match(marketPriceCheck(cmp(0.001, 0.02)).hint, /room to raise/);
  assert.equal(marketPriceCheck(cmp(0.005, 0.001)).hint, undefined, '5x but a cent-level gap: the preflight says nothing, so neither does the hint');
});
