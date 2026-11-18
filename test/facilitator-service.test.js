// The Solana facilitator for sellers (lib/facilitator-service.js): billing (free settles per payTo, then credits),
// the OFAC screen before every settle, the daily cap, refunds when a settle fails, and the wiring in server.js.
// The facilitator itself is a stand-in here; test/solana-facilitator.test.js runs the real one against a mock RPC.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const credits = require('../lib/credits');
const { createFacilitatorService, USDC_MINT } = require('../lib/facilitator-service');
const { createApp } = require('../server');

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PAY_TO = 'Seller1111111111111111111111111111111111111';
const PAYER = 'Buyer11111111111111111111111111111111111111';
const LISTED = 'Listed1111111111111111111111111111111111111';

function fakeCore({ verify = { isValid: true, payer: PAYER }, settle = null } = {}) {
  const calls = { verify: 0, settle: 0 };
  return {
    calls,
    network: SOLANA,
    feePayer: async () => 'FeePayer11111111111111111111111111111111111',
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: 'FeePayer11111111111111111111111111111111111' } }], extensions: [], signers: {} }),
    async verify() { calls.verify++; return typeof verify === 'function' ? verify() : verify; },
    async settle(_p, r) { calls.settle++; return settle ? settle() : { success: true, transaction: `tx${calls.settle}`, network: SOLANA, payer: PAYER, amount: r.amount }; },
  };
}

const sanctions = (listed = [], { up = true } = {}) => ({
  enabled: true,
  ready: async () => (up ? { published: '2026-11-13' } : null),
  check: (a) => ({ listed: listed.includes(a), entries: [] }),
});

function body({ payTo = PAY_TO, network = SOLANA, asset = USDC_MINT } = {}) {
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: {}, payload: { transaction: 'AAAA' } },
    paymentRequirements: { scheme: 'exact', network, asset, amount: '20000', payTo, maxTimeoutSeconds: 300, extra: { feePayer: 'FeePayer11111111111111111111111111111111111' } },
  };
}

async function serve(service) {
  const app = express();
  app.use(service.router(express));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, b, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  return { url, post, close: () => server.close() };
}

test('off without a key: info says so, verify/settle answer 503', async () => {
  const svc = createFacilitatorService({ env: {}, sanctions: sanctions() });
  assert.equal(svc.enabled, false);
  const s = await serve(svc);
  try {
    const info = await (await fetch(`${s.url}/facilitator`)).json();
    assert.equal(info.enabled, false);
    assert.equal((await s.post('/facilitator/settle', body())).status, 503);
  } finally { s.close(); }
});

test('free settles per payTo per day, then a 402 that says how to pay', async () => {
  const core = fakeCore();
  const svc = createFacilitatorService({ env: {}, core, sanctions: sanctions(), freePerDay: 2 });
  const s = await serve(svc);
  try {
    for (const n of [1, 2]) {
      const r = await s.post('/facilitator/settle', body());
      assert.equal(r.status, 200);
      assert.equal((await r.json()).transaction, `tx${n}`);
      assert.equal(r.headers.get('x-facilitator-billing'), 'free');
    }
    const r3 = await s.post('/facilitator/settle', body());
    assert.equal(r3.status, 402);
    const j = await r3.json();
    assert.equal(j.success, false);
    assert.equal(j.errorReason, 'facilitator_payment_required');
    assert.match(j.errorMessage, /credit key/);
    assert.equal(core.calls.settle, 2, 'nothing settled after the free ones');
    // Another seller still has its own free settles.
    assert.equal((await s.post('/facilitator/settle', body({ payTo: 'Other11111111111111111111111111111111111111' }))).status, 200);
  } finally { s.close(); }
});

test('a credit key pays 1 credit a settle (x-credit-key or Bearer); a failed settle gives it back', async () => {
  const store = credits.memoryStore();
  const key = credits.newKey();
  await store.issue(credits.hashKey(key), 3, 365);
  let fail = false;
  const core = fakeCore({ settle: () => (fail ? { success: false, errorReason: 'transaction_failed', transaction: '', network: SOLANA } : { success: true, transaction: 'txok', network: SOLANA, payer: PAYER }) });
  const svc = createFacilitatorService({ env: {}, core, sanctions: sanctions(), creditStore: store, freePerDay: 0 });
  const s = await serve(svc);
  try {
    const r1 = await s.post('/facilitator/settle', body(), { 'x-credit-key': key });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-facilitator-billing'), 'credits');
    assert.equal(r1.headers.get('x-facilitator-remaining'), '2');
    const r2 = await s.post('/facilitator/settle', body(), { authorization: `Bearer ${key}` });
    assert.equal(r2.status, 200);
    assert.equal((await store.balance(credits.hashKey(key))).credits, 1);
    fail = true;
    const r3 = await s.post('/facilitator/settle', body(), { 'x-credit-key': key });
    assert.equal((await r3.json()).success, false);
    assert.equal((await store.balance(credits.hashKey(key))).credits, 1, 'credit refunded after a failed settle');
    const bad = await s.post('/facilitator/settle', body(), { 'x-credit-key': 'nope' });
    assert.equal(bad.status, 402);
    assert.equal((await bad.json()).errorReason, 'facilitator_invalid_credit_key');
  } finally { s.close(); }
});

test('sanctions: a listed payTo or payer is never settled; an unreadable list fails closed', async () => {
  const core = fakeCore({ verify: { isValid: true, payer: LISTED } });
  const s = await serve(createFacilitatorService({ env: {}, core, sanctions: sanctions([LISTED]) }));
  try {
    const toListed = await (await s.post('/facilitator/settle', body({ payTo: LISTED }))).json();
    assert.equal(toListed.success, false);
    assert.equal(toListed.errorReason, 'sanctioned_address');
    const fromListed = await (await s.post('/facilitator/settle', body())).json();
    assert.equal(fromListed.errorReason, 'sanctioned_address');
    assert.equal(fromListed.payer, LISTED);
    const v = await (await s.post('/facilitator/verify', body())).json();
    assert.equal(v.isValid, false);
    assert.equal(v.invalidReason, 'sanctioned_address');
    assert.equal(core.calls.settle, 0);
  } finally { s.close(); }
  const down = await serve(createFacilitatorService({ env: {}, core: fakeCore(), sanctions: sanctions([], { up: false }) }));
  try {
    const j = await (await down.post('/facilitator/settle', body())).json();
    assert.equal(j.errorReason, 'sanctions_screen_unavailable');
  } finally { down.close(); }
});

test('only Solana mainnet USDC with scheme exact; a bad body is a 400', async () => {
  const core = fakeCore();
  const s = await serve(createFacilitatorService({ env: {}, core, sanctions: sanctions() }));
  try {
    assert.equal((await (await s.post('/facilitator/settle', body({ network: 'eip155:8453' }))).json()).errorReason, 'unsupported_network');
    assert.equal((await (await s.post('/facilitator/settle', body({ asset: 'So11111111111111111111111111111111111111112' }))).json()).errorReason, 'unsupported_asset');
    assert.equal((await s.post('/facilitator/verify', { nope: 1 })).status, 400);
    assert.equal(core.calls.verify + core.calls.settle, 0);
  } finally { s.close(); }
});

test('the daily cap stops settling; an invalid payment gives its free settle back', async () => {
  let valid = false;
  const core = fakeCore({ verify: () => (valid ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: 'invalid_exact_svm_payload_transaction_amount_mismatch', payer: PAYER }) });
  const svc = createFacilitatorService({ env: {}, core, sanctions: sanctions(), freePerDay: 1, dailyMax: 1 });
  const s = await serve(svc);
  try {
    const bad = await (await s.post('/facilitator/settle', body())).json();
    assert.equal(bad.errorReason, 'invalid_exact_svm_payload_transaction_amount_mismatch');
    valid = true;
    assert.equal((await s.post('/facilitator/settle', body())).status, 200, 'the refunded free settle is used here');
    const capped = await s.post('/facilitator/settle', body({ payTo: 'Other11111111111111111111111111111111111111' }));
    assert.equal(capped.status, 503);
    assert.equal((await capped.json()).errorReason, 'facilitator_daily_limit');
    assert.equal(svc.status().settled, 1);
  } finally { s.close(); }
});

test('supported passes the facilitator through; info names fee payer, pricing and how to use it', async () => {
  const s = await serve(createFacilitatorService({ env: {}, core: fakeCore(), sanctions: sanctions() }));
  try {
    const sup = await (await fetch(`${s.url}/facilitator/supported`)).json();
    assert.equal(sup.kinds[0].network, SOLANA);
    const info = await (await fetch(`${s.url}/facilitator`)).json();
    assert.equal(info.enabled, true);
    assert.match(info.fee_payer, /^FeePayer/);
    assert.match(info.pricing.settle, /free a day per payTo/);
    assert.match(info.how_to_use, /HTTPFacilitatorClient/);
  } finally { s.close(); }
});

test('server.js: /facilitator is mounted, big bodies pass, /api/health reports it, settles are logged', async () => {
  const logged = [];
  const usageLog = { middleware: (describe) => (req, res, next) => { res.on('finish', () => logged.push(describe(req, res, res.locals.__body))); next(); } };
  const core = fakeCore();
  const facilitator = createFacilitatorService({ env: {}, core, sanctions: sanctions() });
  const app = createApp({ allowPrivate: true, env: {}, usageLog, facilitator, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const big = body();
    big.paymentPayload.extensions = { bazaar: { info: { pad: 'x'.repeat(9000) } } }; // over the 4 kB default
    const r = await fetch(`${url}/facilitator/settle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(big) });
    assert.equal(r.status, 200);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.facilitator.enabled, true);
    assert.equal(health.facilitator.settled, 1);
    const entry = logged.find((e) => e && e.route === 'facilitator settle');
    assert.ok(entry, JSON.stringify(logged));
    assert.equal(entry.via, 'free');
    assert.equal(entry.payment, null);
    assert.equal(entry.input.pay_to, PAY_TO);
  } finally { server.close(); }
});
