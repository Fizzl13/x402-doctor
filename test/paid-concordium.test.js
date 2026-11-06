// Doctor's own paid routes on Concordium mainnet (lib/concordium-pay.js): USDR through our Concordium facilitator,
// paid to the owner of Doctor's agent #5120, on routes of $0.05 and up, with the facilitator's sponsor in
// extra.feePayer. Off unless CONCORDIUM_PAY_TO and CONCORDIUM_FACILITATOR_URL are set.

process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { paymentConfig } = require('../lib/paid-api');
const { CONCORDIUM_MAINNET, ExactConcordiumScheme, atomic6 } = require('../lib/concordium-pay');
const { diagnose } = require('../lib/diagnose');
const { usdOf } = require('../lib/usage-log');

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const OWNER = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J'; // owner of agent #5120 on mainnet
const SPONSOR = '4nkWEqH5534jL4LkSQAuL6zZdZugaU171DXqVvWB7uHbecuYS6';

const servers = [];
test.after(() => servers.forEach((s) => s.close()));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
const facilitator = (kinds) => listen((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.endsWith('/supported') ? { kinds, extensions: [], signers: {} } : { isValid: false }));
});
async function challengeFor(env, path) {
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const res = await fetch(`${api}${path}`);
  assert.equal(res.status, 402, path);
  return JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
}

test('paymentConfig: USDR on Concordium only when configured, and only on routes of $0.05 and up', () => {
  const base = { AGENT_PAYOUT_WALLET: PAY_TO_BASE };
  const on = { ...base, CONCORDIUM_PAY_TO: OWNER, CONCORDIUM_FACILITATOR_URL: 'https://ccd.example' };
  assert.equal(paymentConfig(base).fixAccepts.some((a) => a.network === CONCORDIUM_MAINNET), false, 'off by default');
  assert.equal(paymentConfig({ ...base, CONCORDIUM_PAY_TO: OWNER }).fixAccepts.some((a) => a.network === CONCORDIUM_MAINNET), false, 'no facilitator, no option');
  const c = paymentConfig(on).fixAccepts.find((a) => a.network === CONCORDIUM_MAINNET);
  assert.deepEqual(c.price, { amount: '50000', asset: 'USDR', extra: { decimals: 6 } }, '$0.05 in USDR (6 decimals)');
  assert.equal(c.payTo, OWNER);
  assert.ok(paymentConfig(on).deliveryAccepts.some((a) => a.network === CONCORDIUM_MAINNET), 'the $0.25 delivery check too');
  assert.equal(paymentConfig(on).preflightAccepts.some((a) => a.network === CONCORDIUM_MAINNET), false, '$0.001: the sponsor fee would be more than the price');
  assert.equal(paymentConfig(on).fixAccepts[0].network, BASE, 'Base stays first');
  assert.equal(paymentConfig({ ...on, CONCORDIUM_PAY_TO: 'not-an-account' }).fixAccepts.some((a) => a.network === CONCORDIUM_MAINNET), false);
  assert.equal(atomic6('$0.25'), '250000');
  assert.equal(usdOf({ ...c, amount: c.price.amount }), 0.05, 'the usage log counts it as $0.05');
});

test('the scheme copies the facilitator\'s sponsor into extra.feePayer, and takes only asset amounts', async () => {
  const s = new ExactConcordiumScheme();
  assert.deepEqual(await s.parsePrice({ amount: '50000', asset: 'USDR', extra: { decimals: 6 } }, CONCORDIUM_MAINNET), { amount: '50000', asset: 'USDR', extra: { decimals: 6 } });
  await assert.rejects(s.parsePrice('$0.05', CONCORDIUM_MAINNET));
  const r = await s.enhancePaymentRequirements({ amount: '50000', asset: 'USDR', extra: { decimals: 6 } }, { extra: { feePayer: SPONSOR } });
  assert.deepEqual(r.extra, { decimals: 6, feePayer: SPONSOR });
  assert.deepEqual((await s.enhancePaymentRequirements({ extra: {} }, { extra: { feePayer: 'nope' } })).extra, {});
});

test('402: the fix route offers USDR on Concordium with the sponsor as fee payer; x402 Doctor\'s own check passes it', async () => {
  const payai = await facilitator([{ x402Version: 2, scheme: 'exact', network: BASE }]);
  const ccd = await facilitator([{ x402Version: 2, scheme: 'exact', network: CONCORDIUM_MAINNET, extra: { feePayer: SPONSOR } }]);
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, CONCORDIUM_PAY_TO: OWNER, CONCORDIUM_FACILITATOR_URL: ccd };
  const challenge = await challengeFor(env, `/api/v1/fix?url=${encodeURIComponent('https://example.com/')}`);
  const c = challenge.accepts.find((a) => a.network === CONCORDIUM_MAINNET);
  assert.ok(c, JSON.stringify(challenge.accepts.map((a) => a.network)));
  assert.deepEqual([c.scheme, c.amount, c.asset, c.payTo, c.extra.feePayer, c.extra.decimals], ['exact', '50000', 'USDR', OWNER, SPONSOR, 6]);
  assert.ok(challenge.accepts.some((a) => a.network === BASE), 'Base stays');
  // The cheap preflight has no Concordium option.
  const cheap = await challengeFor(env, `/api/v1/preflight?url=${encodeURIComponent('https://example.com/')}`);
  assert.equal(cheap.accepts.some((a) => a.network === CONCORDIUM_MAINNET), false);
  // Doctor's own web check reads the option as a valid Concordium one (amount, fee payer).
  const seller = await listen((req, res) => {
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json');
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify({ ...challenge, accepts: [c] })).toString('base64'));
    res.end(JSON.stringify({ ...challenge, accepts: [c] }));
  });
  const { createSafeFetch } = require('../lib/safe-fetch');
  const report = await diagnose(`${seller}/paid`, { safeFetch: createSafeFetch({ allowPrivate: true }) });
  const ids = (id) => report.checks.find((x) => x.id === id)?.status;
  assert.deepEqual([ids('accepts[0]-amount'), ids('accepts[0]-feepayer')], ['pass', 'pass'], JSON.stringify(report.checks.filter((x) => x.id.startsWith('accepts[0]'))));
});
