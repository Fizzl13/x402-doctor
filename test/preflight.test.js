// Pre-payment check (lib/preflight.js, GET /api/v1/preflight) against local
// x402 sellers, a mock Solana RPC and a stub Bazaar index. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSafeFetch } = require('../lib/safe-fetch');
const { preflight, createPreflight } = require('../lib/preflight');
const { createBazaarIndex } = require('../lib/bazaar-index');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const PAY_TO_SOLANA = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';
const NO_ATA_SOLANA = 'HDp3B6rtQV5X9FmMgCLabGkkk4Lfzm1ncraeLFoQEV4a';
const FEE_PAYER = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';

const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
test.after(() => servers.forEach((s) => s.close()));

const baseOption = (amount, extra = {}) => ({ scheme: 'exact', network: BASE, amount, asset: USDC_BASE, payTo: PAY_TO_BASE, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' }, ...extra });
const solanaOption = (amount, payTo = PAY_TO_SOLANA) => ({ scheme: 'exact', network: SOLANA, amount, asset: USDC_SOLANA, payTo, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } });

// A seller: /paid answers 402 with the given accepts[]; /openapi.json advertises a price.
async function seller({ accepts, advertised = '0.02', status = 402 }) {
  let origin;
  origin = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') {
      return res.end(JSON.stringify({ openapi: '3.1.0', info: { title: 't' }, paths: { '/paid/{id}': { get: { 'x-payment-info': { protocols: ['x402'], price: { mode: 'fixed', currency: 'USD', amount: advertised } } } } } }));
    }
    const challenge = { x402Version: 2, resource: { url: `${origin}${req.url.split('?')[0]}`, mimeType: 'application/json', description: 'x' }, accepts };
    res.statusCode = status;
    if (status === 402) res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(status === 402 ? challenge : { ok: true }));
  });
  return `${origin}/paid/1`;
}

let rpcUrl;
test.before(async () => {
  rpcUrl = await listen(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const owner = body.params?.[0];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { value: owner === NO_ATA_SOLANA ? [] : [{ pubkey: 'x' }] } }));
  });
});

const safeFetch = createSafeFetch({ allowPrivate: true });
const listed = { lookup: async () => ({ resource: true, origin: true }) };
const unlisted = { lookup: async () => ({ resource: false, origin: false }) };
const run = (url, opts = {}) => preflight(url, { safeFetch, rpcUrl, bazaarIndex: listed, ...opts });

test('healthy seller: go, cheapest USDC option recommended, signals filled in', async () => {
  const url = await seller({ accepts: [baseOption('20000'), solanaOption('15000')] });
  const r = await run(url);
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  assert.equal(r.safe_to_pay, true);
  assert.equal(r.recommended_option, 1);
  assert.equal(r.options[1].usd, 0.015);
  assert.equal(r.options[0].asset_symbol, 'USDC');
  assert.match(r.summary, /OK to pay: \$0.015 on Solana/);
  assert.equal(r.signals.advertised_price_usd, 0.02);
  assert.equal(r.signals.listed_in_cdp_bazaar, true);
});

test('network preference picks the option on that network, or no_go when it is not offered', async () => {
  const url = await seller({ accepts: [baseOption('20000'), solanaOption('15000')] });
  assert.equal((await run(url, { network: BASE })).recommended_option, 0);
  const r = await run(await seller({ accepts: [baseOption('20000')] }), { network: SOLANA });
  assert.equal(r.verdict, 'no_go');
  assert.equal(r.reasons[0].code, 'network_not_offered');
});

test('budget: above max_usd is no_go', async () => {
  const r = await run(await seller({ accepts: [baseOption('20000')] }), { maxUsd: 0.01 });
  assert.equal(r.verdict, 'no_go');
  assert.equal(r.safe_to_pay, false);
  assert.ok(r.reasons.some((x) => x.code === 'over_budget'));
  assert.match(r.summary, /^Do not pay/);
});

test('charging more than the OpenAPI advertises is a caution', async () => {
  const r = await run(await seller({ accepts: [baseOption('100000')], advertised: '0.02' }));
  assert.equal(r.verdict, 'caution');
  assert.ok(r.reasons.some((x) => x.code === 'price_above_advertised'));
});

test('Solana payout wallet without a USDC token account: that option is not payable', async () => {
  const onlySolana = await run(await seller({ accepts: [solanaOption('15000', NO_ATA_SOLANA)] }));
  assert.equal(onlySolana.verdict, 'no_go');
  assert.equal(onlySolana.options[0].payable, false);
  assert.match(onlySolana.options[0].problems.join(' '), /no token account/);
  const withBase = await run(await seller({ accepts: [baseOption('20000'), solanaOption('15000', NO_ATA_SOLANA)] }));
  assert.equal(withBase.verdict, 'go');
  assert.equal(withBase.recommended_option, 0);
});

test('broken options, unknown token and non-402 endpoints', async () => {
  const noFeePayer = await run(await seller({ accepts: [{ ...solanaOption('15000'), extra: {} }] }));
  assert.equal(noFeePayer.verdict, 'no_go');
  const otherToken = await run(await seller({ accepts: [baseOption('20000', { asset: '0x1111111111111111111111111111111111111111' })] }));
  assert.equal(otherToken.verdict, 'caution');
  assert.ok(otherToken.reasons.some((x) => x.code === 'unknown_asset'));
  const free = await run(await seller({ accepts: [], status: 200 }));
  assert.equal(free.verdict, 'no_go');
  assert.equal(free.reasons[0].code, 'no_402');
});

test('not listed in the CDP Bazaar is only information', async () => {
  const r = await run(await seller({ accepts: [baseOption('20000')] }), { bazaarIndex: unlisted });
  assert.equal(r.verdict, 'go');
  assert.ok(r.reasons.some((x) => x.code === 'not_in_bazaar' && x.level === 'info'));
});

test('results are cached for repeated checks', async () => {
  let hits = 0;
  const origin = await listen((req, res) => {
    hits++;
    res.statusCode = 404;
    res.end('{}');
  });
  const cached = createPreflight({ safeFetch, rpcUrl, bazaarIndex: listed });
  const first = await cached(`${origin}/x`);
  const hitsAfterFirst = hits;
  const second = await cached(`${origin}/x`);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(hits, hitsAfterFirst);
});

test('Bazaar index: loads all pages once, matches by origin + path, ignores the query', async () => {
  let calls = 0;
  const page = (n, offset) => Array.from({ length: n }, (_, i) => ({ resource: `https://s${offset + i}.example/api?x=1` }));
  const fetchImpl = async (url) => {
    calls++;
    const offset = Number(new URL(url).searchParams.get('offset'));
    const items = offset === 0 ? [...page(499, 0), { resource: 'https://seller.example/paid/1?q=2' }] : page(3, offset);
    return { ok: true, json: async () => ({ items }) };
  };
  const index = createBazaarIndex({ url: 'https://cdp.test/discovery', fetchImpl });
  assert.deepEqual(await index.lookup('https://seller.example/paid/1', { waitMs: 1000 }), { resource: true, origin: true });
  assert.deepEqual(await index.lookup('https://seller.example/other'), { resource: false, origin: true });
  assert.deepEqual(await index.lookup('https://nobody.example/x'), { resource: false, origin: false });
  assert.equal(calls, 2);
  assert.equal(index.size(), 503);
});
