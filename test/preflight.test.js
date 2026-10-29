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

test('price: above $100 a call is a caution without max_usd; with max_usd the budget decides', async () => {
  const pricey = await seller({ accepts: [baseOption(String(1_000_000 * 1e6))], advertised: '1000000' });
  const r = await run(pricey);
  assert.equal(r.verdict, 'caution', JSON.stringify(r.reasons));
  assert.ok(r.reasons.some((x) => x.code === 'price_very_high'));
  const within = await run(pricey, { maxUsd: 2_000_000 });
  assert.ok(!within.reasons.some((x) => x.code === 'price_very_high'), 'a budget the user set decides instead');
  assert.ok((await run(pricey, { maxUsd: 1 })).reasons.some((x) => x.code === 'over_budget'));
  const normal = await run(await seller({ accepts: [baseOption('20000')] }));
  assert.ok(!normal.reasons.some((x) => x.code === 'price_very_high'));
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

test('charging ten times the advertised price or more is no_go', async () => {
  const far = await run(await seller({ accepts: [baseOption('5000000')], advertised: '0.005' }));
  assert.equal(far.verdict, 'no_go');
  assert.equal(far.safe_to_pay, false);
  const reason = far.reasons.find((x) => x.code === 'price_far_above_advertised');
  assert.match(reason.message, /^Charges \$5 but its OpenAPI advertises \$0\.005 for this route: 1000 times as much\.$/);
  assert.ok(!far.reasons.some((x) => x.code === 'price_above_advertised'));
  const ten = await run(await seller({ accepts: [baseOption('100000')], advertised: '0.01' }));
  assert.equal(ten.verdict, 'no_go', 'exactly ten times');
  const nine = await run(await seller({ accepts: [baseOption('90000')], advertised: '0.01' }));
  assert.equal(nine.verdict, 'caution', 'below ten times stays a caution');
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
  // Only server errors (Cloudflare's 530: it can't reach the origin): the server is down, not missing a 402.
  const down = await run(await seller({ accepts: [], status: 530 }));
  assert.equal(down.verdict, 'no_go');
  assert.equal(down.reasons[0].code, 'server_error');
  assert.match(down.reasons[0].message, /530/);
  const notImplemented = await run(await seller({ accepts: [], status: 501 }));
  assert.equal(notImplemented.reasons[0].code, 'no_402', '501 says the method is not implemented, not that the server is down');
});

test('no answer and free trials: unreachable (a timeout next to a 405) and free_trial (a caution), not no_402', async () => {
  const sleepy = await listen((req, res) => {
    if (req.method === 'POST') { res.statusCode = 405; return res.end('{}'); }
    setTimeout(() => res.end('{}'), 1500).unref();
  });
  const slow = await preflight(`${sleepy}/paid`, { safeFetch: createSafeFetch({ allowPrivate: true, timeoutMs: 300 }) });
  assert.equal(slow.verdict, 'no_go');
  assert.equal(slow.reasons[0].code, 'unreachable');
  assert.match(slow.reasons[0].message, /GET timed out after 0\.3s, POST 405/);
  const trial = await listen((req, res) => { res.setHeader('x-free-trial', 'true'); res.end('{}'); });
  const free = await run(`${trial}/paid`);
  assert.equal(free.verdict, 'caution');
  assert.deepEqual(free.reasons.map((r) => r.code), ['free_trial']);
});

test("Vercel's own 402 for a switched-off deployment is host_disabled, not a broken challenge", async () => {
  const off = await listen((req, res) => {
    res.statusCode = 402;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('x-vercel-error', 'DEPLOYMENT_DISABLED');
    res.end('Payment required\n\nDEPLOYMENT_DISABLED\n\niad1::abc-123\n');
  });
  const disabled = await run(`${off}/x402/v1/email-validation`);
  assert.equal(disabled.verdict, 'no_go');
  assert.deepEqual(disabled.reasons.filter((r) => r.level !== 'info').map((r) => r.code), ['host_disabled']);
  assert.match(disabled.reasons.find((r) => r.code === 'host_disabled').message, /Vercel has switched this deployment off \(DEPLOYMENT_DISABLED\)/);
  // The same page without Vercel's header stays a broken challenge.
  const plain = await listen((req, res) => { res.statusCode = 402; res.setHeader('content-type', 'text/plain'); res.end('Payment required'); });
  const broken = await run(`${plain}/paid`);
  assert.equal(broken.verdict, 'no_go');
  assert.ok(broken.reasons.some((r) => r.code === 'invalid_challenge') && !broken.reasons.some((r) => r.code === 'host_disabled'));
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

test('payTo is the zero or 0x…dEaD address: no_go on its own, caution next to a payable option', async () => {
  let url = await seller({ accepts: [baseOption('20000', { payTo: '0x0000000000000000000000000000000000000000' })] });
  let r = await run(url);
  assert.equal(r.verdict, 'no_go');
  assert.equal(r.options[0].payable, false);
  const burn = r.reasons.find((x) => x.code === 'payto_burn');
  assert.equal(burn.level, 'no_go');
  assert.match(burn.message, /the zero address .*USDC refuses the transfer/);
  url = await seller({ accepts: [baseOption('10000', { payTo: '0x000000000000000000000000000000000000dEaD' }), solanaOption('20000')] });
  r = await run(url);
  assert.equal(r.verdict, 'caution', JSON.stringify(r.reasons));
  assert.equal(r.recommended_option, 1, 'the cheaper option pays out to a burn address');
  assert.match(r.reasons.find((x) => x.code === 'payto_burn').message, /money would be lost\. Pay only through another option/);
  url = await mppSeller({ challenges: [{ method: 'evm', request: { ...evmRequest('20000'), recipient: '0x0000000000000000000000000000000000000000' } }] });
  r = await preflight(url, { safeFetch, rpcUrl });
  assert.equal(r.verdict, 'no_go');
  assert.ok(r.reasons.some((x) => x.code === 'payto_burn'));
});

test('on-chain payments: how many wallets paid the Base payout address shows as info and in signals, never changes the verdict', async () => {
  const url = await seller({ accepts: [baseOption('20000'), solanaOption('15000')] });
  const asked = [];
  const stats = { network: BASE, days: 7, payments: 312, payers: 47, usd: 3.12, coverage: 1, as_of: '2026-10-19T05:00:00.000Z' };
  let r = await run(url, { payments: { lookup: async (payTo) => { asked.push(payTo); return { ...stats, pay_to: payTo.toLowerCase() }; } } });
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  assert.deepEqual(asked, [PAY_TO_BASE], 'the Solana option is recommended, so the Base option is looked up');
  const line = r.reasons.find((x) => x.code === 'onchain_payments');
  assert.equal(line.level, 'info');
  assert.match(line.message, /^47 different wallets paid this seller's payout address on Base in the last 7 days: 312 signed USDC payments, \$3\.12 in total/);
  assert.equal(r.signals.onchain_payments.payers, 47);
  assert.doesNotMatch(line.message, /checkers and scanners/, 'no wide payers: nothing about them');
  r = await run(url, { payments: { lookup: async () => ({ ...stats, payers_wide: 5 }) } });
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /\$3\.12 in total .*\)\. 5 of these wallets paid 10 or more different sellers in the same days, as checkers and scanners do\.$/);
  r = await run(url, { payments: { lookup: async () => ({ ...stats, payers: 2, payers_wide: 2 }) } });
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /All of them paid 10 or more different sellers in the same days, as checkers and scanners do: no ordinary buyer seen yet\.$/);
  assert.equal(r.verdict, 'go', 'a signal only');
  // Payers the payout address sent USDC back to: a closed loop says so; a refund is mentioned plainly.
  r = await run(url, { payments: { lookup: async () => ({ ...stats, payers: 1, payers_paid_back: 1, usd_paid_back: 3.1, closed_loop: true }) } });
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /Every ordinary payer also received USDC back from this payout address \(\$3\.1 of the \$3\.12 paid in\): this looks like the seller paying its own endpoint, not outside demand\.$/);
  assert.equal(r.verdict, 'go', 'still a signal only');
  assert.equal(r.signals.onchain_payments.closed_loop, true);
  r = await run(url, { payments: { lookup: async () => ({ ...stats, payers_paid_back: 2, usd_paid_back: 0.05 }) } });
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /2 of these wallets also received USDC from this payout address \(\$0\.05\), such as refunds or the seller's own wallets\.$/);
  r = await run(url, { payments: { lookup: async () => ({ ...stats, days: 1, payments: 0, payers: 0, usd: 0 }) } });
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /^No signed USDC payments reached this seller's payout address on Base yesterday\. Not a problem by itself/);
  r = await run(url, { payments: { lookup: async () => null } });
  assert.ok(!r.reasons.some((x) => x.code === 'onchain_payments'), 'not watched: nothing said');
  assert.equal(r.signals.onchain_payments, undefined);
});

test('on-chain payments on X Layer: a USD₮0 option is looked up with its network, so the X Layer count answers, not Base\'s', async () => {
  const xlayerOption = { scheme: 'exact', network: 'eip155:196', amount: '20000', asset: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', payTo: PAY_TO_BASE, maxTimeoutSeconds: 60, extra: { name: 'USD₮0', version: '1' } };
  const url = await seller({ accepts: [xlayerOption] });
  const asked = [];
  const stats = { network: 'eip155:196', symbol: 'USD₮0 or USDC', days: 7, payments: 12, payers: 3, usd: 0.12, coverage: 1, as_of: '2026-10-29T05:00:00.000Z' };
  const r = await run(url, { payments: { lookup: async (payTo, o) => { asked.push([payTo, o.network]); return { ...stats, pay_to: payTo.toLowerCase() }; } } });
  assert.deepEqual(asked, [[PAY_TO_BASE, 'eip155:196']]);
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /^3 different wallets paid this seller's payout address on X Layer in the last 7 days: 12 signed USD₮0 or USDC payments, \$0\.12 in total/);
});

test('on-chain payments on Solana: a seller without a Base option is looked up by its Solana payout address; options carry the fee payer', async () => {
  const url = await seller({ accepts: [solanaOption('15000')] });
  const asked = [];
  const stats = { network: SOLANA, days: 7, payments: 40, payers: 9, usd: 0.6, coverage: 1, as_of: '2026-10-24T05:00:00.000Z' };
  let r = await run(url, { payments: { lookup: async (payTo) => { asked.push(payTo); return { ...stats, pay_to: payTo }; } } });
  assert.deepEqual(asked, [PAY_TO_SOLANA], 'the base58 address, case kept');
  assert.equal(r.options[0].fee_payer, FEE_PAYER);
  const line = r.reasons.find((x) => x.code === 'onchain_payments');
  assert.match(line.message, /^9 different wallets paid this seller's payout address on Solana in the last 7 days: 40 USDC payments, \$0\.6 in total \(their network fee paid by an x402 facilitator, the way x402 settles on Solana\)\.$/);
  r = await run(url, { payments: { lookup: async () => ({ ...stats, days: 1, payments: 0, payers: 0, usd: 0 }) } });
  assert.match(r.reasons.find((x) => x.code === 'onchain_payments').message, /^No USDC payments reached this seller's payout address on Solana yesterday\./);
});

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

test("the weekly spot-buy: a signal always; money taken for the seller's own example with an error back is a caution", async () => {
  const url = await seller({ accepts: [baseOption('20000')] });
  const spotOf = (result, request) => ({ forUrl: async (u) => (u === url ? { url, date: '2026-10-18', result, request, price_usd: 0.02, charged_usd: result === 'delivered' || result === 'charged_not_delivered' ? 0.02 : 0, status: result === 'delivered' ? 200 : 422, ...(result === 'delivered' ? {} : { reason: 'json_schema is required' }) } : null) });
  const lost = await run(url, { spot: spotOf('charged_not_delivered', 'example') });
  assert.equal(lost.verdict, 'caution');
  const reason = lost.reasons.find((r) => r.code === 'charged_without_answer');
  assert.match(reason.message, /spot-buy of 2026-10-18 this endpoint took \$0\.02 for the example request its own listing declares and answered HTTP 422 \(json_schema is required\)/);
  assert.deepEqual([lost.signals.spot_buy.result, lost.signals.spot_buy.request], ['charged_not_delivered', 'example']);
  const plain = await run(url, { spot: spotOf('charged_not_delivered', 'plain') });
  assert.equal(plain.verdict, 'go', 'with a plain request it may have been our input: a signal only');
  assert.equal(plain.signals.spot_buy.result, 'charged_not_delivered');
  const fine = await run(url, { spot: spotOf('delivered', 'example') });
  assert.equal(fine.verdict, 'go');
  assert.equal(fine.signals.spot_buy.status, 200);
  assert.equal((await run(url)).signals.spot_buy, undefined, 'not bought: no signal');
  // A timeout after paying, and a slow but delivered answer.
  const timedOut = { forUrl: async () => ({ url, date: '2026-10-18', result: 'charged_not_delivered', request: 'example', charged_usd: 0.05, status: null, timed_out: true, answer_s: 90 }) };
  assert.match((await run(url, { spot: timedOut })).reasons.find((r) => r.code === 'charged_without_answer').message, /took \$0\.05 .* and gave no answer within 90 seconds/);
  const slow = await run(url, { spot: { forUrl: async () => ({ url, date: '2026-10-18', result: 'delivered', request: 'example', status: 200, answer_s: 34.2 }) } });
  assert.equal(slow.verdict, 'go', 'slow is information, not a caution');
  assert.match(slow.reasons.find((r) => r.code === 'slow_after_payment').message, /answered 34\.2 seconds after the first request.*allow at least 50 seconds/);
  assert.equal(fine.reasons.find((r) => r.code === 'slow_after_payment'), undefined, 'no answer time: nothing to say');
});

const USD1_BNB = '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d';
const USDT_BNB = '0x55d398326f99059fF775485246999027B3197955';
const bnbOption = (amount, asset = USD1_BNB, extra = { name: 'World Liberty Financial USD', version: '1' }) => ({ scheme: 'exact', network: 'eip155:56', amount, asset, payTo: PAY_TO_BASE, maxTimeoutSeconds: 60, extra });

test('BNB Chain: 18-decimal dollar tokens are priced, so the budget and the advertised price apply', async () => {
  const ok = await run(await seller({ accepts: [bnbOption('10000000000000000')] }));
  assert.equal(ok.verdict, 'go', JSON.stringify(ok.reasons));
  assert.deepEqual([ok.options[0].network_name, ok.options[0].asset_symbol, ok.options[0].usd], ['BNB Chain', 'USD1', 0.01]);
  const over = await run(await seller({ accepts: [bnbOption('20000000000000000')] }), { maxUsd: 0.01 });
  assert.ok(over.reasons.some((x) => x.code === 'over_budget'));
  const far = await run(await seller({ accepts: [bnbOption('1000000000000000000')], advertised: '0.02' }));
  assert.equal(far.verdict, 'no_go');
  assert.ok(far.reasons.some((x) => x.code === 'price_far_above_advertised'));
});

test('X Layer, Celo and Robinhood Chain: priced in their dollar tokens; a wrong USDC domain on Celo is not payable', async () => {
  const option = (network, asset, extra, amount = '10000') => ({ scheme: 'exact', network, amount, asset, payTo: PAY_TO_BASE, maxTimeoutSeconds: 60, extra });
  const xlayer = await run(await seller({ accepts: [option('eip155:196', '0x779Ded0c9e1022225f8E0630b35a9b54bE713736', { name: 'USD₮0', version: '1' })] }));
  assert.equal(xlayer.verdict, 'go', JSON.stringify(xlayer.reasons));
  assert.deepEqual([xlayer.options[0].network_name, xlayer.options[0].asset_symbol, xlayer.options[0].usd], ['X Layer', 'USD₮0', 0.01]);
  const usdg = await run(await seller({ accepts: [option('eip155:4663', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', { name: 'Global Dollar', version: '1' }, '30000')] }), { maxUsd: 0.02 });
  assert.deepEqual([usdg.options[0].network_name, usdg.options[0].asset_symbol, usdg.options[0].usd], ['Robinhood Chain', 'USDG', 0.03]);
  assert.ok(usdg.reasons.some((x) => x.code === 'over_budget'));
  const celo = await run(await seller({ accepts: [option('eip155:42220', '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', { name: 'USD Coin', version: '2' })] }));
  assert.equal(celo.verdict, 'no_go');
  assert.equal(celo.options[0].payable, false);
  assert.match(celo.options[0].problems[0], /signs as "USDC" v2/);
});

test('BNB Chain: USDT over EIP-3009 is not payable; a 6-decimal amount on an 18-decimal token is a caution', async () => {
  const usdt = await run(await seller({ accepts: [bnbOption('10000000000000000', USDT_BNB, { name: 'Tether USD', version: '1' })] }));
  assert.equal(usdt.verdict, 'no_go');
  assert.equal(usdt.options[0].payable, false);
  assert.match(usdt.options[0].problems[0], /no transferWithAuthorization/);
  const mixed = await run(await seller({ accepts: [bnbOption('10000000000000000', USDT_BNB, { name: 'Tether USD', version: '1' }), baseOption('10000')] }));
  assert.equal(mixed.verdict, 'go', JSON.stringify(mixed.reasons));
  assert.equal(mixed.recommended_option, 1);
  const tiny = await run(await seller({ accepts: [bnbOption('10000')] }));
  assert.equal(tiny.verdict, 'caution');
  assert.ok(tiny.reasons.some((x) => x.code === 'suspicious_amount'));
});

// Nevermined's documented 402 (nevermined.ai/docs/development-guide/nevermined-x402): a plan, no amount or payTo.
const PLAN = '44742763076047497640080230236781474129970992727896593861997347135613135571071';
const nvmOption = (scheme = 'nvm:erc4337', network = 'eip155:8453') => ({ scheme, network, planId: PLAN, extra: { version: '1', agentId: '80918427023170428029540261117198154464497879145267720259488529685089104529015' } });

test('Nevermined plans: a caution (payable only with a Nevermined account), not a no_go; next to an exact option, the exact one', async () => {
  for (const option of [nvmOption(), nvmOption('nvm:card-delegation', 'stripe')]) {
    const r = await run(await seller({ accepts: [option] }));
    assert.equal(r.verdict, 'caution', JSON.stringify(r.reasons));
    assert.deepEqual(r.reasons.map((x) => x.code), ['nevermined_plan']);
    assert.match(r.reasons[0].message, /Nevermined account/);
    assert.deepEqual([r.options[0].payable, r.options[0].client, r.options[0].plan_id], [false, 'nevermined', PLAN]);
  }
  const mixed = await run(await seller({ accepts: [nvmOption(), baseOption('10000')] }));
  assert.equal(mixed.verdict, 'go', JSON.stringify(mixed.reasons));
  assert.equal(mixed.recommended_option, 1);
  const broken = await run(await seller({ accepts: [{ ...nvmOption(), planId: undefined }] }));
  assert.equal(broken.verdict, 'no_go');
  assert.ok(broken.reasons.some((x) => x.code === 'no_payable_option'));
});

test('unknown schemes: never recommended over a standard option; only them is a caution; a burn address still a no_go', async () => {
  const custom = (scheme, amount = '5000', extra = {}) => ({ ...baseOption(amount), scheme, ...extra });
  const only = await run(await seller({ accepts: [custom('settled-transfer')] }));
  assert.equal(only.verdict, 'caution', JSON.stringify(only.reasons));
  assert.deepEqual(only.reasons.map((x) => x.code), ['custom_scheme_only']);
  assert.match(only.reasons[0].message, /"settled-transfer"/);
  assert.deepEqual([only.options[0].payable, only.options[0].client], [false, 'custom']);
  // Cheaper, but in a scheme a standard client can't pay: the exact option is the one to take.
  const mixed = await run(await seller({ accepts: [custom('agent-pay', '1000'), baseOption('10000')] }));
  assert.equal(mixed.verdict, 'go', JSON.stringify(mixed.reasons));
  assert.equal(mixed.recommended_option, 1);
  const noFields = await run(await seller({ accepts: [{ scheme: 'aggr_deferred', network: BASE }] }));
  assert.equal(noFields.verdict, 'caution', JSON.stringify(noFields.reasons));
  assert.ok(noFields.reasons.some((x) => x.code === 'custom_scheme_only'));
  const burned = await run(await seller({ accepts: [custom('memo-transfer', '5000', { payTo: '0x0000000000000000000000000000000000000000' })] }));
  assert.equal(burned.verdict, 'no_go');
  assert.ok(burned.reasons.some((x) => x.code === 'payto_burn'));
});

// Cloudflare pay per crawl (x402 specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md): USD in cents,
// payTo "merchant", paid by agents registered with Cloudflare.
const cloudflareOption = (over = {}) => ({ scheme: 'batch-settlement', network: 'cloudflare:402', amount: '1', asset: 'USD', payTo: 'merchant', extra: { version: '1.0.0' }, ...over });

test('Cloudflare pay per crawl: a caution (payable by agents registered with Cloudflare), not a no_go; max_usd is checked in dollars', async () => {
  const r = await run(await seller({ accepts: [cloudflareOption()] }));
  assert.equal(r.verdict, 'caution', JSON.stringify(r.reasons));
  assert.deepEqual(r.reasons.map((x) => x.code), ['cloudflare_crawler_only']);
  assert.match(r.reasons[0].message, /\(\$0\.01 a request\).*registered with Cloudflare/);
  assert.deepEqual([r.options[0].payable, r.options[0].client, r.options[0].usd], [false, 'cloudflare', 0.01]);
  const pricey = await run(await seller({ accepts: [cloudflareOption({ amount: '250' })] }), { maxUsd: 1 });
  assert.equal(pricey.verdict, 'no_go');
  assert.deepEqual(pricey.reasons.map((x) => x.code), ['cloudflare_crawler_only', 'over_budget']);
  // Next to an exact option, the exact one is what a standard client pays.
  const mixed = await run(await seller({ accepts: [cloudflareOption(), baseOption('10000')] }));
  assert.equal(mixed.verdict, 'go', JSON.stringify(mixed.reasons));
  assert.equal(mixed.recommended_option, 1);
  const broken = await run(await seller({ accepts: [cloudflareOption({ amount: '0.01' })] }));
  assert.equal(broken.verdict, 'no_go');
  assert.ok(broken.reasons.some((x) => x.code === 'no_payable_option'));
});

test('auth-capture: a well-formed option is payable like any standard scheme; one with a passed capture deadline is not', async () => {
  const now = Math.floor(Date.now() / 1000);
  const extra = { name: 'USD Coin', version: '2', captureAuthorizer: '0x1111111111111111111111111111111111111111', captureDeadline: now + 86400, refundDeadline: now + 604800, minFeeBps: 0, maxFeeBps: 100, feeRecipient: '0x3333333333333333333333333333333333333333' };
  const ok = await run(await seller({ accepts: [{ ...baseOption('10000'), scheme: 'auth-capture', extra }] }));
  assert.equal(ok.verdict, 'go', JSON.stringify(ok.reasons));
  assert.deepEqual([ok.options[0].payable, ok.options[0].client, ok.options[0].usd], [true, undefined, 0.01]);
  const late = await run(await seller({ accepts: [{ ...baseOption('10000'), scheme: 'auth-capture', extra: { ...extra, captureDeadline: now - 60 } }] }));
  assert.equal(late.verdict, 'no_go');
  assert.match(late.options[0].problems.join(' '), /captureDeadline .* has passed/);
});

test('at the same price, the option every x402 client can pay is recommended over a Permit2 one', async () => {
  const permit2 = bnbOption('10000000000000000', USDT_BNB, { name: 'Tether USD', version: '1', assetTransferMethod: 'permit2-exact' });
  const r = await run(await seller({ accepts: [permit2, baseOption('10000')] }));
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  assert.equal(r.recommended_option, 1);
  const cheaper = await run(await seller({ accepts: [bnbOption('5000000000000000', USDT_BNB, { name: 'Tether USD', version: '1', assetTransferMethod: 'permit2' }), baseOption('10000')] }));
  assert.equal(cheaper.recommended_option, 0, 'a lower price still wins');
  const usd1First = await run(await seller({ accepts: [bnbOption('10000000000000000'), baseOption('10000')] }));
  assert.equal(usd1First.recommended_option, 1, 'USDC before USD1 at the same price');
});

test('a $0 quote: the price depends on the request, so caution and a priced option first', async () => {
  const zero = await run(await seller({ accepts: [baseOption('0')] }));
  assert.equal(zero.verdict, 'caution', JSON.stringify(zero.reasons));
  assert.ok(zero.reasons.some((x) => x.code === 'price_depends_on_request'));
  assert.ok(!zero.reasons.some((x) => x.code === 'no_payable_option'));
  assert.equal(zero.options[0].payable, true);
  const mixed = await run(await seller({ accepts: [baseOption('0'), baseOption('10000')] }));
  assert.equal(mixed.recommended_option, 1);
  assert.ok(!mixed.reasons.some((x) => x.code === 'price_depends_on_request'));
});

test('namesake (lib/namesakes.js): an info line from the track record, the verdict stays', async () => {
  const url = await seller({ accepts: [baseOption('20000')] });
  const namesake = { name: 'X402 Doctor', original: { site: 'fizzl.eu', url: 'https://x402-doctor.fizzl.eu/api/v1/preflight', payers: 6 }, payers: 4 };
  const trustIndex = { lookup: async () => ({ days_checked: 5, days_payable: 5, payable_ratio: 1, history: 'ggggg', last: 'g', streak: 5, namesake }) };
  const r = await run(url, { trustIndex });
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  const line = r.reasons.find((x) => x.code === 'namesake');
  assert.equal(line.level, 'info');
  assert.match(line.message, /"X402 Doctor" is also at fizzl\.eu \(6 payers in the last 30 days, this one 4\), with a different payout address/);
});
