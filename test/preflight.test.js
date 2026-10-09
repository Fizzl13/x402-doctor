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

// A v1 seller: the challenge is only in the body, networks have plain names, the price is maxAmountRequired.
async function sellerV1({ network = 'base', asset = USDC_BASE, amount = '20000' } = {}) {
  let origin;
  origin = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
    res.statusCode = 402;
    res.end(JSON.stringify({ x402Version: 1, error: 'X-PAYMENT header is required', accepts: [{ scheme: 'exact', network, maxAmountRequired: amount, resource: `${origin}${req.url.split('?')[0]}`, description: 'x', mimeType: 'application/json', payTo: PAY_TO_BASE, maxTimeoutSeconds: 60, asset, extra: { name: 'USD Coin', version: '2' } }] }));
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

test('what other agents reported after paying: a failing majority from three wallets is a caution', async () => {
  const url = await seller({ accepts: [baseOption('20000')] });
  const fine = await run(url, { outcomes: { lookup: () => ({ reports: 5, failed: 1, failed_payers: 1 }) } });
  assert.equal(fine.verdict, 'go', JSON.stringify(fine.reasons));
  assert.deepEqual(fine.signals.agent_outcomes, { reports: 5, failed: 1, failed_payers: 1 });
  const failing = await run(url, { outcomes: { lookup: () => ({ reports: 4, failed: 3, failed_payers: 3 }) } });
  assert.equal(failing.verdict, 'caution');
  assert.ok(failing.reasons.some((r) => r.code === 'payments_fail_after_preflight'));
  const none = await run(url);
  assert.equal(none.signals.agent_outcomes, null);
});

// An MPP seller: /paid answers 402 with WWW-Authenticate: Payment challenges (and an x402 challenge when given).
async function mppSeller({ challenges, accepts = null }) {
  const origin = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
    res.statusCode = 402;
    const host = new URL(origin).hostname;
    res.setHeader('www-authenticate', challenges.map((c) => `Payment id="${c.id || 'c1'}", realm="${c.realm ?? host}", method="${c.method}", intent="charge", request="${Buffer.from(JSON.stringify(c.request)).toString('base64url')}", expires="${c.expires || new Date(Date.now() + 300000).toISOString()}"`).join(', '));
    if (accepts) {
      const challenge = { x402Version: 2, resource: { url: `${origin}${req.url}`, mimeType: 'application/json', description: 'x' }, accepts };
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    }
    res.end('{}');
  });
  return `${origin}/paid/1`;
}
const evmRequest = (amount) => ({ amount, currency: USDC_BASE, methodDetails: { chainId: 8453, credentialTypes: ['authorization'], decimals: 6 }, recipient: PAY_TO_BASE });
const tempoRequest = (amount) => ({ amount, currency: '0x20c000000000000000000000b9537d11c60e8b50', recipient: PAY_TO_BASE, methodDetails: { decimals: 6 } });

test('MPP only (evm, USDC on Base): go, the MPP option is recommended, with an mpp_only note', async () => {
  const url = await mppSeller({ challenges: [{ method: 'evm', request: evmRequest('20000') }] });
  const r = await preflight(url, { safeFetch, rpcUrl, maxUsd: 0.05 });
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  const best = r.options[r.recommended_option];
  assert.deepEqual([best.protocol, best.method, best.network, best.asset_symbol, best.usd, best.pay_to], ['mpp', 'evm', BASE, 'USDC', 0.02, PAY_TO_BASE]);
  assert.ok(r.reasons.some((x) => x.code === 'mpp_only' && x.level === 'info'));
  assert.deepEqual(r.signals.protocols, ['mpp']);
  assert.deepEqual(r.signals.mpp_methods, ['evm']);
  const over = await preflight(url, { safeFetch, rpcUrl, maxUsd: 0.01 });
  assert.equal(over.verdict, 'no_go');
  assert.ok(over.reasons.some((x) => x.code === 'over_budget'));
});

test('MPP only: Tempo and Stripe options are priced; an expired challenge is not payable', async () => {
  let url = await mppSeller({ challenges: [{ method: 'tempo', request: tempoRequest('50000') }, { id: 'c2', method: 'stripe', request: { amount: '5', currency: 'usd', decimals: 2 } }] });
  let r = await preflight(url, { safeFetch, rpcUrl });
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  assert.deepEqual(r.options.map((o) => [o.method, o.network_name, o.asset_symbol, o.usd]), [['tempo', 'Tempo', 'USDC.e', 0.05], ['stripe', 'Stripe (card)', 'USD', 0.05]]);
  url = await mppSeller({ challenges: [{ method: 'evm', request: evmRequest('20000'), expires: '2020-01-01T00:00:00Z' }] });
  r = await preflight(url, { safeFetch, rpcUrl });
  assert.equal(r.verdict, 'no_go');
  assert.match(r.options[0].problems[0], /expired/);
});

test('x402 and MPP both offered: the x402 option stays recommended, MPP options are listed after it', async () => {
  const url = await mppSeller({ challenges: [{ method: 'evm', request: evmRequest('10000') }], accepts: [baseOption('20000')] });
  const r = await preflight(url, { safeFetch, rpcUrl });
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  assert.deepEqual(r.options.map((o) => [o.index, o.protocol]), [[0, 'x402'], [1, 'mpp']]);
  assert.equal(r.recommended_option, 0);
  assert.deepEqual(r.signals.protocols, ['x402', 'mpp']);
  assert.ok(!r.reasons.some((x) => x.code === 'mpp_only'));
});

test('v1 challenge on "base" is Base mainnet USDC, not testnet_only/unknown_asset', async () => {
  const r = await run(await sellerV1());
  const codes = r.reasons.map((x) => x.code);
  assert.ok(!codes.includes('testnet_only'), JSON.stringify(r.reasons));
  assert.ok(!codes.includes('unknown_asset'), JSON.stringify(r.reasons));
  assert.equal(r.options[0].network, BASE);
  assert.equal(r.options[0].network_name, 'Base');
  assert.equal(r.options[0].usd, 0.02);
  assert.equal((await run(await sellerV1(), { network: BASE })).recommended_option, 0);
  const sepolia = await run(await sellerV1({ network: 'base-sepolia', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }));
  assert.ok(sepolia.reasons.some((x) => x.code === 'testnet_only'));
});

test('a lowercase USDC address is still USDC (EVM addresses are case-insensitive)', async () => {
  const r = await run(await seller({ accepts: [baseOption('20000', { asset: USDC_BASE.toLowerCase() })] }));
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  assert.equal(r.options[0].asset_symbol, 'USDC');
  assert.equal(r.options[0].usd, 0.02);
});

test('bait check (TypeSafe Jev, opt-in): caution or info added, never no_go; skipped when not payable', async () => {
  const url = await seller({ accepts: [baseOption('20000')] });
  const calls = [];
  const lure = (j) => ({ enabled: true, judge: async (host, claims) => { calls.push({ host, claims }); return j; } });
  const r = await run(url, { lure: lure({ impersonation: 0.95, lure: 0.6, mismatch: null }) });
  assert.equal(r.verdict, 'caution', JSON.stringify(r.reasons));
  assert.equal(r.safe_to_pay, true);
  assert.deepEqual(r.reasons.filter((x) => /brand|lure|mismatch/.test(x.code)).map((x) => [x.level, x.code]), [['caution', 'brand_impersonation'], ['info', 'lure_description']]);
  assert.deepEqual(r.signals.jev_lure, { impersonation: 0.95, lure: 0.6, mismatch: null });
  assert.equal(calls[0].claims.description, 'x');
  const clean = await run(url, { lure: lure({ impersonation: 0.1, lure: 0.1, mismatch: null }) });
  assert.equal(clean.verdict, 'go');
  const before = calls.length;
  const over = await run(url, { maxUsd: 0.001, lure: lure({ impersonation: 0.99, lure: 0.99, mismatch: 0.99 }) });
  assert.equal(over.verdict, 'no_go');
  assert.equal(calls.length, before, 'not asked when the payment would not be made anyway');
  assert.equal((await run(url, { lure: lure(null) })).verdict, 'go');
});

test('price check (TypeSafe Jev + Trust Index, opt-in): the reason and signal are added, asked next to the bait check, never no_go', async () => {
  const url = await seller({ accepts: [baseOption('500000')], advertised: '0.5' }); // $0.50
  const calls = [];
  const price = (cmp) => ({ enabled: true, compare: async (u, args) => { calls.push({ u, ...args }); return cmp; } });
  const cmp = { price_usd: 0.5, comparable_median_usd: 0.01, comparables: 6, ratio: 50, cheaper: [{ url: 'https://cheap.example/a', price_usd: 0.005, description: 'same' }] };
  const r = await run(url, { price: price(cmp) });
  assert.equal(r.verdict, 'caution', JSON.stringify(r.reasons));
  const reason = r.reasons.find((x) => x.code === 'price_high');
  assert.equal(reason.level, 'caution');
  assert.match(reason.message, /50x the median of \$0\.01 across 6 comparable/);
  assert.match(reason.message, /cheap\.example\/a \(\$0\.005\)/);
  assert.deepEqual(r.signals.price_check, cmp);
  assert.deepEqual(calls[0], { u: url, description: 'x', priceUsd: 0.5 });
  assert.equal((await run(url, { price: price(null) })).verdict, 'go');
  assert.equal((await run(url, { price: price(null) })).signals.price_check, undefined);
  const before = calls.length;
  assert.equal((await run(url, { maxUsd: 0.01, price: price(cmp) })).verdict, 'no_go');
  assert.equal(calls.length, before, 'not asked when the payment would not be made anyway');
  // A failing comparison never breaks the preflight.
  const broken = { enabled: true, compare: async () => { throw new Error('boom'); } };
  assert.equal((await run(url, { price: broken })).verdict, 'go');
});
