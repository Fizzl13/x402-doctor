// Spot-buy sample (lib/spot-buy.js): candidate selection, and a whole run against local sellers paid with the
// real x402 client (payments signed offline with a throwaway key; the "chain" is a counter). No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createSanctions } = require('../lib/sanctions');
const { recordPayments } = require('../lib/spot-wallet');
const { selectCandidates, runSpotBuy, classify, reasonOf, cacheRisk, exampleRequest, isoWeek, ownTarget, INDEX_PAYMENT, indexCapFor, staleRoutes, LIMITS, USER_AGENT } = require('../lib/spot-buy');

const BASE = 'eip155:8453';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const LISTED = '0x2222222222222222222222222222222222222222';

test('selection: go x402 resources on Base under the cap, https, not ours or test hosts, one per host, seeded', () => {
  const r = (h, price, networks = [BASE], extra = {}) => ({ h, last: { verdict: 'go', price_usd: price, networks }, ...extra });
  const index = { days: ['2026-10-12'], resources: {
    'https://a.example/x': r('ggg', 0.01),
    'https://a.example/y': r('ggg', 0.01),
    'https://b.example/x': r('ggc', 0.01), // caution today
    'https://c.example/x': r('ggg', 0.2), // over the cap
    'https://d.example/x': r('ggg', 0.01, ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']), // not on Base
    'https://e.example/x': r('ggg', 0.01, [BASE], { p: 'mpp' }), // MPP
    'http://f.example/x': r('ggg', 0.01), // plain http
    'https://presign-guard.fizzl.eu/v1/token': r('ggg', 0.01), // ours
    'https://staging.g.example/x': r('ggg', 0.01), // test host
    'https://h.example/x': r('ggg', 0), // free
    'https://i.example/x': r('ggg', 0.05),
  } };
  const one = selectCandidates(index, { n: 10, capUsd: 0.05, seed: 'w1' });
  assert.deepEqual(one.pool, { hosts: 2, resources: 3 });
  assert.deepEqual(one.picks.map((p) => p.host).sort(), ['a.example', 'i.example']);
  assert.deepEqual(selectCandidates(index, { n: 10, capUsd: 0.05, seed: 'w1' }).picks, one.picks, 'same seed, same sample');
  assert.equal(selectCandidates(index, { n: 1, capUsd: 0.05, seed: 'w1' }).picks.length, 1);
  assert.match(isoWeek(new Date('2026-10-12T00:00:00Z')), /^2026-W42$/);
});

test('classify: 2xx with content, schema, empty, 402 again, errors with and without a charge', () => {
  const schema = { type: 'object', required: ['price'], properties: { price: { type: 'number' } } };
  assert.equal(classify({ status: 200, body: '{"price":1}', outputSchema: schema, chargedUsd: 0.01 }), 'delivered');
  assert.equal(classify({ status: 200, body: '{"nope":1}', outputSchema: schema, chargedUsd: 0.01 }), 'off_schema');
  assert.equal(classify({ status: 200, body: 'plain text', outputSchema: null, chargedUsd: 0.01 }), 'delivered');
  assert.equal(classify({ status: 204, body: '', outputSchema: null, chargedUsd: 0.01 }), 'empty');
  assert.equal(classify({ status: 402, body: '', outputSchema: null, chargedUsd: 0 }), 'payment_rejected');
  assert.equal(classify({ status: 500, body: 'boom', outputSchema: null, chargedUsd: 0.01 }), 'charged_not_delivered');
  assert.equal(classify({ status: 500, body: 'boom', outputSchema: null, chargedUsd: 0 }), 'error_not_charged');
});

// Local sellers, one per behaviour after payment. The "chain": a balance the sellers take from when they settle.
const chain = { balance: 1_000_000 };
const servers = [];
test.after(() => servers.forEach((s) => s.close()));
function seller({ mode, payTo = PAY_TO, amount = '10000', input = null }) {
  return new Promise((resolve) => {
    let origin;
    const used = new Set();
    const server = http.createServer((req, res) => {
      const paid = req.headers['payment-signature'] || req.headers['x-payment'];
      const challenge = {
        x402Version: 2,
        resource: { url: `${origin}${req.url}`, description: `test seller (${mode})`, mimeType: 'application/json' },
        accepts: [{ scheme: 'exact', network: BASE, amount, asset: USDC, payTo, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }],
        extensions: { bazaar: { info: { ...(input ? { input } : {}), output: { example: { price: 1 } } }, schema: { properties: { output: { properties: { example: { type: 'object', required: ['price'], properties: { price: { type: 'number' } } } } } } } } },
      };
      const ask = () => { res.statusCode = 402; res.setHeader('content-type', 'application/json'); res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64')); res.end(JSON.stringify(challenge)); };
      if (req.url === '/openapi.json') { res.statusCode = 404; return res.end(); }
      if (!paid) return ask();
      const settle = () => {
        chain.balance -= Number(amount);
        res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: BASE, payer: '0x' })).toString('base64'));
      };
      if (mode === 'deliver') { settle(); res.setHeader('content-type', 'application/json'); return res.end('{"price":42}'); }
      if (mode === 'deliver_once') {
        // Like a facilitator: a payment it has seen before is refused, so the same header gets the 402 again.
        if (used.has(paid)) return ask();
        used.add(paid); settle(); res.setHeader('content-type', 'application/json'); return res.end('{"price":42}');
      }
      if (mode === 'off_schema') { settle(); return res.end('{"something":"else"}'); }
      if (mode === 'empty') { settle(); res.statusCode = 200; return res.end(); }
      if (mode === 'charge_500') { chain.balance -= Number(amount); res.statusCode = 500; return res.end('upstream error'); }
      if (mode === 'error_500') { res.statusCode = 500; return res.end('upstream error'); }
      if (mode === 'reject') { challenge.error = 'invalid_exact_evm_payload_signature'; return ask(); }
      if (mode === 'needs_symbol') {
        // Validates after payment, without charging: only ?symbol= from its own example makes it deliver.
        if (!new URL(req.url, origin).searchParams.get('symbol')) { res.statusCode = 400; return res.end('{"error":"symbol is required"}'); }
        settle(); return res.end('{"price":1}');
      }
    }).listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve({ url: `${origin}/paid`, host: `127.0.0.1:${server.address().port}`, price_usd: Number(amount) / 1e6 }); });
    servers.push(server);
  });
}

test('a run: each outcome after paying, a listed payout address and the budget stop it before paying', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE)).setSpendControls({ maxAmountPerPayment: '$0.05' });
  client.register(BASE, new ExactEvmScheme(account));
  const payFetch = wrapFetchWithPayment(fetch, client);
  const sanctions = createSanctions({ list: { published: '2026-10-09', addresses: [{ address: LISTED, entries: [{ name: 'TEST', programs: ['X'] }] }] } });
  const modes = ['deliver', 'off_schema', 'empty', 'charge_500', 'error_500', 'reject'];
  const candidates = [];
  for (const mode of modes) candidates.push(await seller({ mode }));
  candidates.push(await seller({ mode: 'deliver', payTo: LISTED }));
  candidates.push(await seller({ mode: 'deliver' })); // the fifth charge fills the budget exactly
  candidates.push(await seller({ mode: 'deliver' })); // a sixth would go over it
  const settled = [];
  const { results, summary } = await runSpotBuy(candidates, {
    safeFetch: createSafeFetch({ allowPrivate: true }),
    payFetch,
    sanctions,
    balance: async () => chain.balance,
    settlement: async (header) => { settled.push(header); return { overall: 'pass', decoded: { transaction: `0x${'ab'.repeat(32)}` }, explorer: null }; },
    capUsd: 0.05,
    budgetUsd: 0.05, // five charges of $0.01
    allowPrivate: true,
    wait: async () => {},
  });
  assert.deepEqual(results.map((r) => r.result), ['delivered', 'off_schema', 'empty', 'charged_not_delivered', 'error_not_charged', 'payment_rejected', 'not_go_now', 'delivered', 'over_budget']);
  assert.equal(results[0].charged_usd, 0.01);
  assert.equal(results[0].proof.overall, 'pass');
  assert.equal(results[3].charged_usd, 0.01);
  assert.equal(results[4].charged_usd, 0);
  assert.equal(results[4].reason, 'upstream error');
  assert.deepEqual(results[4].request, { method: 'GET', url: candidates[4].url, source: 'plain', input_declared: false });
  assert.equal(results[5].reason, 'invalid_exact_evm_payload_signature', 'the x402 error of the 402 that refused the payment');
  assert.equal(results[0].reason, undefined, 'no reason on a delivered answer');
  assert.deepEqual(results[0].cache, { cache_control: null, shared_cache: 'unspecified' }, 'the paid answer said nothing about caching');
  assert.equal(results[4].cache, undefined, 'an error answer is not cached');
  assert.deepEqual(summary.errors_not_charged, { with_example: 0, without_example: 1 });
  assert.equal(results[6].preflight.codes[0], 'payto_sanctioned');
  assert.equal(settled.length, 4, 'the PAYMENT-RESPONSE of each settling seller was checked');
  assert.equal(summary.live, true);
  assert.equal(summary.outcomes.delivered, 2);
  assert.equal(summary.charged_without_answer.count, 1);
  assert.equal(summary.spent_usd, 0.05);
  assert.equal(chain.balance, 1_000_000 - 50_000);
});

test('replay (attack II): the same payment sent once more after the paid answer; a seller that serves it again is flagged', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE)).setSpendControls({ maxAmountPerPayment: '$0.05' });
  client.register(BASE, new ExactEvmScheme(account));
  const payments = recordPayments();
  const candidates = [await seller({ mode: 'deliver_once' }), await seller({ mode: 'deliver' })];
  const opts = { safeFetch: createSafeFetch({ allowPrivate: true }), payFetch: wrapFetchWithPayment(payments.fetch, client), balance: async () => chain.balance, capUsd: 0.05, budgetUsd: 0.05, allowPrivate: true, wait: async () => {} };
  const { results } = await runSpotBuy(candidates, { ...opts, lastPayment: payments.last });
  assert.deepEqual(results.map((r) => r.result), ['delivered', 'delivered']);
  assert.deepEqual(results[0].replay, { status: 402, served: false }, 'the seller refused the used payment');
  assert.deepEqual(results[1].replay, { status: 200, served: true }, 'one payment, two answers');
  assert.equal(payments.last().name, 'payment-signature');
  const without = await runSpotBuy([await seller({ mode: 'deliver' })], opts);
  assert.equal(without.results[0].replay, undefined, 'no replay without the wallet\'s last payment');
});

test('a dry run pays nothing and says what it would buy', async () => {
  const before = chain.balance;
  const c = await seller({ mode: 'deliver' });
  const { results, summary } = await runSpotBuy([c], { safeFetch: createSafeFetch({ allowPrivate: true }), sanctions: createSanctions({ list: { addresses: [{ address: LISTED, entries: [] }] } }), allowPrivate: true });
  assert.equal(results[0].result, 'would_buy');
  assert.equal(results[0].price_usd, 0.01);
  assert.deepEqual(summary, { live: false, sampled: 1, skipped_before_paying: {}, would_buy: 1, spent_usd: 0.01 });
  assert.equal(chain.balance, before);
});

test('an empty wallet stops the run before paying anyone', async () => {
  const a = await seller({ mode: 'deliver' }), b = await seller({ mode: 'deliver' });
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_v, accepts) => accepts.find((x) => x.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const { results } = await runSpotBuy([a, b], { safeFetch: createSafeFetch({ allowPrivate: true }), payFetch: wrapFetchWithPayment(fetch, client), sanctions: createSanctions({ list: { addresses: [{ address: LISTED, entries: [] }] } }), balance: async () => 5000, allowPrivate: true, wait: async () => {} });
  assert.deepEqual(results.map((r) => r.result), ['wallet_empty']);
});

test('cacheRisk: may a shared cache store the paid answer and serve it to someone who did not pay?', () => {
  const res = (status, headers = {}) => ({ status, headers: new Map(Object.entries(headers)) });
  const risk = (headers, method = 'GET', status = 200) => cacheRisk(res(status, headers), method)?.shared_cache;
  assert.equal(risk({ 'cache-control': 'private, no-store' }), 'no');
  assert.equal(risk({ 'cache-control': 'no-store' }), 'no');
  assert.equal(risk({ 'cache-control': 'max-age=60, private' }), 'no');
  assert.equal(risk({ 'cache-control': 'no-cache' }), 'no', 'every reuse goes back to the seller, which asks for payment again');
  assert.equal(risk({ 'cache-control': 'public, max-age=300' }), 'yes');
  assert.equal(risk({ 'cache-control': 's-maxage=60' }), 'yes');
  assert.equal(risk({ 'cache-control': 'max-age=60' }), 'yes');
  assert.equal(risk({ 'cache-control': 'public' }), 'yes');
  assert.equal(risk({ expires: new Date(Date.now() + 3600e3).toUTCString() }), 'yes');
  assert.equal(risk({ 'cache-control': 'public, max-age=0' }), 'unspecified', 'stale on arrival');
  assert.equal(risk({}), 'unspecified');
  assert.equal(risk({ 'cache-control': 'public, max-age=300' }, 'POST'), undefined, 'only GET answers are cached');
  assert.equal(risk({ 'cache-control': 'public, max-age=300' }, 'GET', 500), undefined, 'only successful answers count');
  assert.deepEqual(cacheRisk(res(200, { 'cache-control': 'public, max-age=300' }), 'GET'), { cache_control: 'public, max-age=300', shared_cache: 'yes' });
});

test('reasonOf: the 402 error, a JSON error field or object, else the start of the body on one line', () => {
  const res = (headers = {}) => ({ headers: new Map(Object.entries(headers)) });
  const pr = Buffer.from(JSON.stringify({ x402Version: 2, error: 'insufficient_funds', accepts: [] })).toString('base64');
  assert.equal(reasonOf(res({ 'payment-required': pr }), '{}'), 'insufficient_funds');
  assert.equal(reasonOf(res(), '{"error":"symbol is required"}'), 'symbol is required');
  assert.equal(reasonOf(res(), '{"error":{"code":42,"message":"query parameter q missing"}}'), 'query parameter q missing');
  assert.equal(reasonOf(res(), '<html>\n  <h1>404\tNot Found</h1>\n</html>'), '<html> <h1>404 Not Found</h1> </html>');
  assert.equal(reasonOf(res(), ''), null);
  assert.equal(reasonOf(res(), 'x'.repeat(500)).length, 200);
});

test('the declared example input is sent even without a path template', async () => {
  assert.deepEqual(exampleRequest('https://a.example/v1/price', { info: { input: { type: 'http', method: 'GET', queryParams: { symbol: 'BTC', depth: 5 } } } }), { url: 'https://a.example/v1/price?symbol=BTC&depth=5', method: 'GET' });
  assert.deepEqual(exampleRequest('https://a.example/v1/run', { info: { input: { method: 'POST', body: { code: '1+1' } } } }), { url: 'https://a.example/v1/run', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"1+1"}' });
  assert.equal(exampleRequest('https://a.example/x', { info: {} }), null);
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_v, accepts) => accepts.find((x) => x.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const sanctions = createSanctions({ list: { addresses: [{ address: LISTED, entries: [] }] } });
  const run = async (input) => (await runSpotBuy([await seller({ mode: 'needs_symbol', input })], { safeFetch: createSafeFetch({ allowPrivate: true }), payFetch: wrapFetchWithPayment(fetch, client), sanctions, balance: async () => chain.balance, allowPrivate: true, wait: async () => {} })).results[0];
  const withExample = await run({ type: 'http', method: 'GET', queryParams: { symbol: 'BTC' } });
  assert.equal(withExample.result, 'delivered');
  assert.equal(withExample.request.source, 'example');
  assert.match(withExample.request.url, /\?symbol=BTC$/);
  const without = await run(null);
  assert.equal(without.result, 'error_not_charged');
  assert.equal(without.request.source, 'plain');
  assert.equal(without.reason, 'symbol is required');
});

test('a top-up during a purchase is not a negative charge: the settlement transfer counts', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_v, accepts) => accepts.find((x) => x.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const sanctions = createSanctions({ list: { addresses: [{ address: LISTED, entries: [] }] } });
  const s = await seller({ mode: 'deliver' });
  let topUp = 0;
  const run = async (onchain) => {
    topUp = 0;
    const balance = async () => chain.balance + topUp;
    const { results, summary } = await runSpotBuy([s], { safeFetch: createSafeFetch({ allowPrivate: true }), payFetch: async (...args) => { const res = await wrapFetchWithPayment(fetch, client)(...args); topUp = 1_000_000; return res; }, sanctions, balance, settlement: async () => ({ overall: onchain ? 'pass' : 'warn', decoded: { transaction: `0x${'cd'.repeat(32)}`, payer: account.address }, onchain }), allowPrivate: true, wait: async () => {} });
    return { r: results[0], summary };
  };
  const confirmed = await run({ found: true, ok: true, transfers: [{ token: 'USDC', from: account.address.toLowerCase(), to: PAY_TO.toLowerCase(), amount: 0.01 }] });
  assert.equal(confirmed.r.result, 'delivered');
  assert.equal(confirmed.r.charged_usd, 0.01);
  assert.match(confirmed.r.balance_note, /came into the wallet/);
  assert.equal(confirmed.summary.spent_usd, 0.01);
  const unknown = await run(null);
  assert.equal(unknown.r.charged_usd, null);
  assert.match(unknown.r.balance_note, /unknown/);
  assert.equal(unknown.summary.spent_usd, 0.01, 'an unknown charge counts as the listed price against the budget');
});

test('an indexing payment goes only to one of our own routes', () => {
  assert.deepEqual(ownTarget('https://presign-guard.fizzl.eu/v1/screen?address=TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81'), { url: 'https://presign-guard.fizzl.eu/v1/screen?address=TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81', host: 'presign-guard.fizzl.eu', method: null, price_usd: null });
  assert.equal(ownTarget('https://FIZZL.EU/x').host, 'fizzl.eu');
  for (const bad of ['http://presign-guard.fizzl.eu/v1/screen', 'https://fizzl.eu.example.com/x', 'https://notfizzl.eu/x', 'https://presign-guard.fizzl.eu:8443/x', 'https://u:p@presign-guard.fizzl.eu/x', 'https://a.example/x', 'not a url', '']) {
    assert.equal(ownTarget(bad), null, bad);
  }
  assert.equal(INDEX_PAYMENT.capUsd, 0.01);
  // Each of our routes has its own cap, its price (all to our own payout wallets); any other fizzl.eu URL stays at $0.01.
  assert.equal(indexCapFor(ownTarget('https://x402-doctor.fizzl.eu/api/v1/delivery-check')), 0.25);
  assert.equal(indexCapFor(ownTarget('https://x402-doctor.fizzl.eu/api/v1/delivery-check?url=https%3A%2F%2Fa.example%2Fx')), 0.25);
  assert.equal(indexCapFor(ownTarget('https://presign-guard.fizzl.eu/v1/screen?address=x')), 0.01);
  assert.equal(indexCapFor(ownTarget('https://x402-doctor.fizzl.eu/api/v1/diagnose')), 0.01);
  assert.equal(indexCapFor(ownTarget('https://x402-doctor.fizzl.eu/api/v1/preflight')), 0.001);
  assert.equal(indexCapFor(ownTarget('https://ichimoku-signal.fizzl.eu/signals/BTC-USDT')), 0.15);
  assert.equal(indexCapFor(ownTarget('https://ichimoku-signal.fizzl.eu/setups?top=3')), 0.5);
  assert.equal(indexCapFor(ownTarget('https://ichimoku-signal.fizzl.eu/signal/ETH-USDT')), 0.01, 'only the listed example path has the route cap');
  assert.equal(indexCapFor(ownTarget('https://plaintext.fizzl.eu/api/explain')), 0.01);
  assert.equal(INDEX_PAYMENT.routes.length, 16);
  assert.ok(INDEX_PAYMENT.routes.every((r) => ownTarget(r.url) && r.capUsd > 0 && r.capUsd <= LIMITS.ownCapUsd), 'every route is ours and within the hard ceiling');
  assert.equal(LIMITS.capUsd, 0.1, 'the ceiling for other sellers is unchanged');
  assert.equal(LIMITS.ownCapUsd, 0.5);
});

test('stale routes: our routes whose last settled payment in the Bazaar is 21 days old or more, or that it does not list', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const routes = [
    { url: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', capUsd: 0.02 },
    { url: 'https://ichimoku-signal.fizzl.eu/signals/BTC-USDT', capUsd: 0.15 },
    { url: 'https://ichimoku-signal.fizzl.eu/setups', capUsd: 0.5 },
    { url: 'https://x402-doctor.fizzl.eu/api/v1/preflight/batch', capUsd: 0.005 },
    { url: 'https://presign-guard.fizzl.eu/v1/screen', capUsd: 0.01 },
  ];
  const listed = [
    { resource: 'https://ichimoku-signal.fizzl.eu/signal/:pair', quality: { lastCalledAt: '2026-10-04T14:54:37Z' } }, // 25 days
    { resource: 'https://ichimoku-signal.fizzl.eu/signals/:pair', quality: { lastCalledAt: '2026-09-28T16:12:36Z' } }, // 31 days
    { resource: 'https://ichimoku-signal.fizzl.eu/setups', quality: { lastCalledAt: '2026-10-20T00:00:00Z' } }, // 10 days
    { resource: 'https://x402-doctor.fizzl.eu/api/v1/preflight/batch' }, // listed, no payment date
    { resource: 'https://other.example/signal/:pair', quality: { lastCalledAt: '2026-10-29T00:00:00Z' } },
  ];
  const due = staleRoutes(listed, { routes, now });
  assert.deepEqual(due.map((r) => r.url), [
    'https://x402-doctor.fizzl.eu/api/v1/preflight/batch', // no date: first
    'https://presign-guard.fizzl.eu/v1/screen', // not listed
    'https://ichimoku-signal.fizzl.eu/signals/BTC-USDT', // 31 days
    'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', // 25 days
  ]);
  assert.equal(due.find((r) => r.url.endsWith('/signal/BTC-USDT')).age_days, 25.4);
  assert.equal(due.find((r) => r.url.endsWith('/v1/screen')).listed, false);
  assert.deepEqual(staleRoutes(listed, { routes, now, staleDays: 30 }).map((r) => r.url).slice(2), ['https://ichimoku-signal.fizzl.eu/signals/BTC-USDT'], 'a longer threshold pays fewer');
  assert.equal(staleRoutes([{ resource: 'https://ichimoku-signal.fizzl.eu/signal/:pair', quality: { lastCalledAt: '2026-10-04T00:00:00Z' } }], { routes: [{ url: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT/extra', capUsd: 0.02 }], now })[0].listed, false, 'a template matches one path segment only');
});

test('an own-routes-only run never buys someone else\'s endpoint, whatever its price', async () => {
  let paid = 0;
  const payFetch = async () => { paid++; throw new Error('should not be called'); };
  const run = await runSpotBuy([{ url: 'https://a.example/paid', host: 'a.example', method: null, price_usd: null }], { safeFetch: createSafeFetch({ allowPrivate: true }), payFetch, capUsd: 0.25, budgetUsd: 0.25, ownRoutesOnly: true, wait: async () => {} });
  assert.equal(run.results[0].result, 'not_own');
  assert.equal(paid, 0);
  assert.equal(run.summary.skipped_before_paying.not_own, 1);
});

test('a run can name its own user agent; the default is the spot-buy one', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_v, accepts) => accepts.find((x) => x.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const pay = wrapFetchWithPayment(fetch, client);
  const seen = [];
  const payFetch = (url, init) => { seen.push(init.headers['user-agent']); return pay(url, init); };
  const sanctions = createSanctions({ list: { addresses: [{ address: LISTED, entries: [] }] } });
  const opts = { safeFetch: createSafeFetch({ allowPrivate: true }), payFetch, sanctions, balance: async () => chain.balance, allowPrivate: true, wait: async () => {} };
  const own = await runSpotBuy([await seller({ mode: 'deliver' })], { ...opts, capUsd: INDEX_PAYMENT.capUsd, budgetUsd: INDEX_PAYMENT.capUsd, userAgent: INDEX_PAYMENT.userAgent });
  assert.equal(own.results[0].result, 'delivered');
  assert.equal(own.results[0].charged_usd, 0.01);
  const over = await runSpotBuy([await seller({ mode: 'deliver', amount: '20000' })], { ...opts, capUsd: INDEX_PAYMENT.capUsd, budgetUsd: INDEX_PAYMENT.capUsd });
  assert.equal(over.results[0].result, 'not_go_now', 'a $0.02 route is over the indexing cap: the preflight budget already says no');
  await runSpotBuy([await seller({ mode: 'deliver' })], opts);
  assert.deepEqual(seen, [INDEX_PAYMENT.userAgent, USER_AGENT]);
});
