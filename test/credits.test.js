// Prepaid credits (lib/credits.js): buy a pack with a real x402 payment (mock facilitator that
// verifies the EIP-3009 signature), then pay calls from the credit key without a new payment.
process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { createApp } = require('../server');
const credits = require('../lib/credits');

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const servers = [];
const state = { settle: 0 };
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
const json = (res, value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
async function body(req) { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }

let api; let targetUrl; let store;
test.before(async () => {
  const facilitatorUrl = await listen(async (req, res) => {
    if (req.url.endsWith('/supported')) return json(res, { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }], extensions: [], signers: {} });
    const { paymentPayload } = await body(req);
    const from = paymentPayload.payload.authorization.from;
    if (req.url.endsWith('/verify')) return json(res, { isValid: true, payer: from });
    state.settle++;
    return json(res, { success: true, transaction: '0xsettled', network: BASE, payer: from });
  });
  targetUrl = await listen((_req, res) => {
    const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO_BASE, maxTimeoutSeconds: 60 }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    json(res, challenge);
  });
  store = credits.memoryStore();
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: facilitatorUrl };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, creditStore: store });
  api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
});
test.after(() => servers.forEach((s) => s.close()));

test('costs are the route prices in tenths of a cent', () => {
  assert.deepEqual(credits.creditCosts({ a: '$0.001', b: '$0.005', c: '$0.01', d: '$0.05', e: 'free' }), { a: 1, b: 5, c: 10, d: 50 });
});

test('credit info is free and lists the packs; the paid routes carry the bulk hint', async () => {
  const info = await (await fetch(`${api}/api/v1/credits`)).json();
  assert.equal(info.packs['1000'].price_usd, '0.80');
  assert.equal(info.costs['GET /api/v1/preflight'], 1);
  assert.equal(info.costs['GET /api/v1/fix'], 50);
  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent(targetUrl)}`);
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString());
  assert.match(challenge.resource.description, /Bulk: 1000 credits for \$0\.80/);
});

test('a pack is sold for $0.80 over x402; the key then pays calls without a new payment', async () => {
  const unpaid = await fetch(`${api}/api/v1/credits/1000`);
  assert.equal(unpaid.status, 402);
  const client = new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  const bought = await wrapFetchWithPayment(fetch, client)(`${api}/api/v1/credits/1000`);
  assert.equal(bought.status, 200);
  const pack = await bought.json();
  assert.ok(credits.isKey(pack.credit_key));
  assert.equal(pack.credits, 1000);
  const settled = state.settle;

  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent(targetUrl)}`, { headers: { 'x-credit-key': pack.credit_key } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-credit-status'), 'paid');
  assert.equal(res.headers.get('x-credits-remaining'), '999');
  assert.equal(state.settle, settled, 'no new payment');

  const bal = await (await fetch(`${api}/api/v1/credits`, { headers: { 'x-credit-key': pack.credit_key } })).json();
  assert.equal(bal.credits, 999);
});

test('a failed call gives its credits back; an unknown key falls through to the 402', async () => {
  const key = credits.newKey();
  await store.issue(credits.hashKey(key), 20, 365);
  const bad = await fetch(`${api}/api/v1/diagnose?url=not-a-url`, { headers: { 'x-credit-key': key } });
  assert.equal(bad.status, 400);
  assert.equal((await store.balance(credits.hashKey(key))).credits, 20);
  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent(targetUrl)}`, { headers: { 'x-credit-key': credits.newKey() } });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get('x-credit-status'), 'unknown');
});

test('too few credits: the normal 402, with what is left', async () => {
  const key = credits.newKey();
  await store.issue(credits.hashKey(key), 3, 365);
  const res = await fetch(`${api}/api/v1/diagnose?url=${encodeURIComponent(targetUrl)}`, { headers: { 'x-credit-key': key } });
  assert.equal(res.status, 402);
  assert.equal(res.headers.get('x-credit-status'), 'insufficient');
  assert.equal(res.headers.get('x-credits-remaining'), '3');
});

test('no pack sale while the store is not connected', async () => {
  const off = createApp({ allowPrivate: true, env: { AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: 'http://127.0.0.1:1' }, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, creditStore: { ...credits.memoryStore(), ready: false } });
  const url = await new Promise((resolve) => { const s = off.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
  const res = await fetch(`${url}/api/v1/credits/1000`);
  assert.equal(res.status, 503);
});
