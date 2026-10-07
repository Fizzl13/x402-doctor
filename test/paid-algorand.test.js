// The Doctor's own paid routes in USDC on Algorand next to Base: only with ALGORAND_PAY_TO, settled by
// GoPlausible's facilitator (a mock here).

process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { paymentConfig } = require('../lib/paid-api');

const BASE = 'eip155:8453';
const ALGORAND = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const PAY_TO_ALGORAND = 'SGLTUPAC7TKGKNNXKNPQ2QZCC7NJSLAKYZ7O7NOGGAPXWBFZTOLTPMSPPI';
const FEE_PAYER = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA';

const servers = [];
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
const supported = (kinds) => (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.endsWith('/supported') ? { kinds, extensions: [], signers: {} } : { isValid: false }));
};
test.after(() => servers.forEach((s) => s.close()));

test('paymentConfig: Algorand only with ALGORAND_PAY_TO, "off" turns it off', () => {
  const base = { AGENT_PAYOUT_WALLET: PAY_TO_BASE };
  assert.equal(paymentConfig(base).accepts.some((a) => a.network === ALGORAND), false);
  assert.equal(paymentConfig({ ...base, ALGORAND_PAY_TO: 'off' }).accepts.some((a) => a.network === ALGORAND), false);
  const a = paymentConfig({ ...base, ALGORAND_PAY_TO: ` ${PAY_TO_ALGORAND} ` }).accepts.find((x) => x.network === ALGORAND);
  assert.equal(a.payTo, PAY_TO_ALGORAND);
  assert.equal(a.price, '$0.01');
});

test('402 offers USDC (ASA 31566704) on Algorand with GoPlausible\'s fee payer; PayAI never claims Algorand', async () => {
  // The PayAI mock also claims Algorand, with another fee payer: GoPlausible must win.
  const payai = await listen(supported([
    { x402Version: 2, scheme: 'exact', network: BASE },
    { x402Version: 2, scheme: 'exact', network: ALGORAND, extra: { feePayer: 'WRONGFEEPAYER' } },
  ]));
  const goplausible = await listen(supported([{ x402Version: 2, scheme: 'exact', network: ALGORAND, extra: { feePayer: FEE_PAYER } }]));
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, ALGORAND_PAY_TO: PAY_TO_ALGORAND, ALGORAND_FACILITATOR_URL: goplausible };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent('https://example.com/')}`);
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
  const algo = challenge.accepts.find((a) => a.network === ALGORAND);
  assert.ok(algo, `no Algorand option in ${JSON.stringify(challenge.accepts.map((a) => a.network))}`);
  assert.equal(algo.asset, '31566704');
  assert.equal(algo.amount, '1000');
  assert.equal(algo.payTo, PAY_TO_ALGORAND);
  assert.equal(algo.extra.feePayer, FEE_PAYER);
  assert.ok(challenge.accepts.some((a) => a.network === BASE), 'Base stays');
});

test('usage log: an Algorand USDC payment is named "algorand" and counted in dollars', () => {
  const { usdOf } = require('../lib/usage-log');
  assert.equal(usdOf({ network: ALGORAND, asset: '31566704', amount: '1000' }), 0.001);
});
