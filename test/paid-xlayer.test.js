// The Doctor's own paid routes (and Fizzl Buy's) in USD₮0 on X Layer next to Base: in production (CDP configured) to
// the Base payout wallet, or wherever XLAYER_PAY_TO says; PayAI settles it.

process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { paymentConfig, usdt0Amount, XLAYER, XLAYER_USDT0 } = require('../lib/paid-api');
const { routesFor } = require('../buy-server');

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const OTHER = '0x551faCB18b3f173F300c944a3BDcbe1A2847A6AF';
const CDP = { CDP_API_KEY_ID: 'id', CDP_API_KEY_SECRET: 'secret' };

const servers = [];
test.after(() => servers.forEach((s) => s.close()));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});

test('usdt0Amount: dollar prices in USD₮0 units (6 decimals)', () => {
  assert.equal(usdt0Amount('$0.001'), '1000');
  assert.equal(usdt0Amount('$0.25'), '250000');
  assert.throws(() => usdt0Amount('$0.0000001'));
});

test('paymentConfig: X Layer in production to the Base wallet, XLAYER_PAY_TO or "off" otherwise; not in local runs', () => {
  const base = { AGENT_PAYOUT_WALLET: PAY_TO_BASE };
  assert.equal(paymentConfig(base).accepts.some((a) => a.network === XLAYER), false, 'no CDP: local or test run');
  const x = paymentConfig({ ...base, ...CDP }).preflightAccepts.find((a) => a.network === XLAYER);
  assert.equal(x.payTo, PAY_TO_BASE);
  assert.deepEqual(x.price, { amount: '1000', asset: XLAYER_USDT0, extra: { name: 'USD₮0', version: '1' } });
  assert.equal(paymentConfig({ ...base, XLAYER_PAY_TO: OTHER }).accepts.find((a) => a.network === XLAYER).payTo, OTHER);
  assert.equal(paymentConfig({ ...base, ...CDP, XLAYER_PAY_TO: 'off' }).accepts.some((a) => a.network === XLAYER), false);
});

test('402 offers USD₮0 on X Layer through PayAI next to Base', async () => {
  const payai = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/supported')
      ? { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }, { x402Version: 2, scheme: 'exact', network: XLAYER }], extensions: [], signers: {} }
      : { isValid: false }));
  });
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, XLAYER_PAY_TO: PAY_TO_BASE };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent('https://example.com/')}`);
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
  const x = challenge.accepts.find((a) => a.network === XLAYER);
  assert.ok(x, `no X Layer option in ${JSON.stringify(challenge.accepts.map((a) => a.network))}`);
  assert.equal(x.asset, XLAYER_USDT0);
  assert.equal(x.amount, '1000', '$0.001 at 6 decimals');
  assert.equal(x.payTo, PAY_TO_BASE);
  assert.deepEqual(x.extra, { name: 'USD₮0', version: '1' });
  assert.ok(challenge.accepts.some((a) => a.network === BASE), 'Base stays');
});

test('Fizzl Buy offers $0.02 in USD₮0 on X Layer to its own payout wallet', () => {
  const accepts = routesFor({ AGENT_PAYOUT_WALLET: OTHER, ...CDP })['POST /v1/buy'].accepts;
  const x = accepts.find((a) => a.network === XLAYER);
  assert.equal(x.payTo, OTHER);
  assert.equal(x.price.amount, '20000');
});

test('usage log: a USD₮0 payment on X Layer is named "xlayer" and counted in dollars', () => {
  const { usdOf } = require('../lib/usage-log');
  assert.equal(usdOf({ network: XLAYER, asset: XLAYER_USDT0, amount: '10000' }), 0.01);
});

test('Fizzl Buy names USD₮0 on X Layer in its payment text', () => {
  const { networksText } = require('../buy-server');
  const accepts = routesFor({ AGENT_PAYOUT_WALLET: PAY_TO_BASE, XRPL_PAY_TO: 'r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw', XLAYER_PAY_TO: OTHER })['POST /v1/buy'].accepts;
  assert.equal(networksText(accepts), 'USDC on Base, or RLUSD on the XRP Ledger, or USD₮0 on X Layer');
});
