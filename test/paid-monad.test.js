// The Doctor's own paid routes (and Fizzl Buy's) in USDC on Monad next to Base: in production (CDP configured) to the
// Base payout wallet, or wherever MONAD_PAY_TO says; CDP settles it where it lists Monad, else the facilitator in
// Monad's own x402 guide (MONAD_FACILITATOR_URL, "off" for none).

process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { paymentConfig, monadFacilitator, MONAD, DEFAULT_MONAD_FACILITATOR } = require('../lib/paid-api');
const { routesFor, networksText } = require('../buy-server');

const BASE = 'eip155:8453';
const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const OTHER = '0x551faCB18b3f173F300c944a3BDcbe1A2847A6AF';
const CDP = { CDP_API_KEY_ID: 'id', CDP_API_KEY_SECRET: 'secret' };

const servers = [];
test.after(() => servers.forEach((s) => s.close()));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
const facilitator = (networks) => listen((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.endsWith('/supported')
    ? { kinds: networks.map((network) => ({ x402Version: 2, scheme: 'exact', network })), extensions: [], signers: {} }
    : { isValid: false }));
});
async function challengeFor(env) {
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent('https://example.com/')}`);
  assert.equal(res.status, 402);
  return JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
}

test('paymentConfig: Monad in production to the Base wallet, MONAD_PAY_TO or "off" otherwise; not in local runs', () => {
  const base = { AGENT_PAYOUT_WALLET: PAY_TO_BASE };
  assert.equal(paymentConfig(base).accepts.some((a) => a.network === MONAD), false, 'no CDP: local or test run');
  const m = paymentConfig({ ...base, ...CDP }).preflightAccepts.find((a) => a.network === MONAD);
  assert.equal(m.payTo, PAY_TO_BASE);
  assert.equal(m.price, '$0.001', 'a dollar price: USDC is the default asset on Monad');
  assert.equal(paymentConfig({ ...base, MONAD_PAY_TO: OTHER }).accepts.find((a) => a.network === MONAD).payTo, OTHER);
  assert.equal(paymentConfig({ ...base, ...CDP, MONAD_PAY_TO: 'off' }).accepts.some((a) => a.network === MONAD), false);
  assert.equal(paymentConfig({ ...base, ...CDP }).accepts[0].network, BASE, 'Base stays first (the paywall offers it)');
});

test('monadFacilitator: the one in Monad\'s guide by default, MONAD_FACILITATOR_URL or "off", only for Monad', async () => {
  assert.equal(DEFAULT_MONAD_FACILITATOR, 'https://x402-facilitator.molandak.org');
  assert.equal(monadFacilitator({ AGENT_PAYOUT_WALLET: PAY_TO_BASE }), null, 'not without Monad offered');
  assert.equal(monadFacilitator({ MONAD_PAY_TO: OTHER, MONAD_FACILITATOR_URL: 'off' }), null);
  const url = await facilitator([MONAD, BASE]);
  const kinds = (await monadFacilitator({ MONAD_PAY_TO: OTHER, MONAD_FACILITATOR_URL: url }).getSupported()).kinds;
  assert.deepEqual(kinds.map((k) => k.network), [MONAD], 'it never claims Base');
});

test('402 offers USDC on Monad through the fallback facilitator when the others don\'t list Monad', async () => {
  const payai = await facilitator([BASE]);
  const monadF = await facilitator([MONAD]);
  const challenge = await challengeFor({ AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, MONAD_PAY_TO: PAY_TO_BASE, MONAD_FACILITATOR_URL: monadF });
  const m = challenge.accepts.find((a) => a.network === MONAD);
  assert.ok(m, `no Monad option in ${JSON.stringify(challenge.accepts.map((a) => a.network))}`);
  assert.equal(m.asset.toLowerCase(), MONAD_USDC.toLowerCase());
  assert.equal(m.amount, '1000', '$0.001 at 6 decimals');
  assert.equal(m.payTo, PAY_TO_BASE);
  assert.equal(m.extra.name, 'USDC');
  assert.equal(m.extra.version, '2');
  assert.ok(challenge.accepts.some((a) => a.network === BASE), 'Base stays');
});

test('402 leaves Monad out when no facilitator lists it (the other networks still pay)', async () => {
  const payai = await facilitator([BASE]);
  const challenge = await challengeFor({ AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, MONAD_PAY_TO: PAY_TO_BASE, MONAD_FACILITATOR_URL: 'off' });
  assert.equal(challenge.accepts.some((a) => a.network === MONAD), false);
  assert.ok(challenge.accepts.some((a) => a.network === BASE));
});

test('Fizzl Buy offers $0.02 in USDC on Monad to its own payout wallet, and names it', () => {
  const accepts = routesFor({ AGENT_PAYOUT_WALLET: OTHER, ...CDP })['POST /v1/buy'].accepts;
  const m = accepts.find((a) => a.network === MONAD);
  assert.equal(m.payTo, OTHER);
  assert.equal(m.price, '$0.02');
  assert.equal(networksText(routesFor({ AGENT_PAYOUT_WALLET: PAY_TO_BASE, MONAD_PAY_TO: OTHER })['POST /v1/buy'].accepts), 'USDC on Base or Monad');
});

test('usage log: a USDC payment on Monad is named "monad" and counted in dollars', () => {
  const { usdOf } = require('../lib/usage-log');
  assert.equal(usdOf({ network: MONAD, asset: MONAD_USDC, amount: '10000' }), 0.01);
});
