// CCD next to USDR on Doctor's Concordium routes (lib/concordium-ccd.js): the same dollar price in CCD at the chain's
// own CCD/euro rate, on the HTTP paywall only, and absent unless CONCORDIUM_CCD=on or while there is no rate.

process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { paymentConfig } = require('../lib/paid-api');
const { CONCORDIUM_MAINNET, withoutOffTokens } = require('../lib/concordium-pay');
const { microCcdPerEuro, ccdAmount, createCcd } = require('../lib/concordium-ccd');
const { diagnose } = require('../lib/diagnose');
const { usdOf } = require('../lib/usage-log');

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const OWNER = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J';
const SPONSOR = '4nkWEqH5534jL4LkSQAuL6zZdZugaU171DXqVvWB7uHbecuYS6';
// The chain's rate on 12 Nov 2026 (wallet proxy /v0/chainParameters): about 352.5 CCD per euro.
const RATE = { microGTUPerEuro: { denominator: 35769558433, numerator: 12608753779068010496 } };
const FIX = `/api/v1/fix?url=${encodeURIComponent('https://example.com/')}`;

const servers = [];
test.after(() => servers.forEach((s) => s.close()));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
const verified = [];
const facilitator = (kinds) => listen(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/supported')) return res.end(JSON.stringify({ kinds, extensions: [], signers: {} }));
  let raw = '';
  for await (const c of req) raw += c;
  verified.push(JSON.parse(raw).paymentRequirements);
  res.end(JSON.stringify({ isValid: false, invalidReason: 'test' }));
});
const walletProxy = (status = 200) => listen((req, res) => {
  res.statusCode = req.url === '/v0/chainParameters' ? status : 404;
  res.setHeader('content-type', 'application/json');
  res.end(res.statusCode === 200 ? JSON.stringify(RATE) : '{"error":1}');
});
async function start(env) {
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
const challengeOf = async (res) => JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
async function setup(extra = {}) {
  const payai = await facilitator([{ x402Version: 2, scheme: 'exact', network: BASE }]);
  const ccd = await facilitator([{ x402Version: 2, scheme: 'exact', network: CONCORDIUM_MAINNET, extra: { feePayer: SPONSOR, prepare: 'https://ccd.example/prepare' } }]);
  return { AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, CONCORDIUM_PAY_TO: OWNER, CONCORDIUM_FACILITATOR_URL: ccd, CONCORDIUM_WALLET_PROXY: await walletProxy(), CONCORDIUM_CCD: 'on', ...extra };
}

test('the chain rate and the CCD amount: rounded up to two significant digits', () => {
  const perEuro = microCcdPerEuro(RATE);
  assert.ok(Math.abs(perEuro / 1e6 - 352.5) < 0.1, String(perEuro));
  assert.equal(ccdAmount(0.05, 0.9, perEuro), '16000000', '$0.05: 15.9 CCD → 16 CCD');
  assert.equal(ccdAmount(0.25, 0.9, perEuro), '80000000', '$0.25: 79.3 CCD → 80 CCD');
  assert.equal(ccdAmount(1, 1, 16e6), '16000000', 'an exact amount stays');
  assert.equal(ccdAmount(0.000001, 1, 1), '1', 'at least one microCCD');
  for (const bad of [null, {}, { microGTUPerEuro: { numerator: 1, denominator: 0 } }, { microGTUPerEuro: { numerator: -1, denominator: 2 } }]) assert.equal(microCcdPerEuro(bad), null);
  assert.equal(ccdAmount(0.05, 0.9, 0), null);
});

test('402 of the fix route: CCD right after USDR on Concordium, same payee and sponsor; a payment in CCD reaches the facilitator', async () => {
  const api = await start(await setup());
  const challenge = await challengeOf(await fetch(`${api}${FIX}`));
  const onCcd = challenge.accepts.filter((a) => a.network === CONCORDIUM_MAINNET);
  assert.deepEqual(onCcd.map((a) => [a.asset, a.amount]), [['USDR', '50000'], ['CCD', '16000000']]);
  const c = onCcd[1];
  assert.deepEqual([c.scheme, c.payTo, c.extra.feePayer, c.extra.prepare, c.extra.decimals, c.maxTimeoutSeconds], ['exact', OWNER, SPONSOR, 'https://ccd.example/prepare', 6, 120]);
  assert.equal(challenge.accepts[0].network, BASE, 'Base stays first');
  // A payment for the CCD option matches it: the facilitator is asked to verify exactly that.
  verified.length = 0;
  const payload = { x402Version: 2, accepted: c, payload: { transaction: 'ab' } };
  const paid = await fetch(`${api}${FIX}`, { headers: { 'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64') } });
  assert.equal(paid.status, 402);
  assert.equal(verified.length, 1, 'the facilitator was asked');
  assert.deepEqual([verified[0].asset, verified[0].amount, verified[0].payTo], ['CCD', '16000000', OWNER]);
  // The cheap preflight has no Concordium option at all.
  const cheap = await challengeOf(await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent('https://example.com/')}`));
  assert.equal(cheap.accepts.some((a) => a.network === CONCORDIUM_MAINNET), false);
  // The usage log values a CCD payment at the same rate: 16 CCD is about $0.05.
  const usd = usdOf({ network: CONCORDIUM_MAINNET, asset: 'CCD', amount: '16000000' });
  assert.ok(usd > 0.05 && usd < 0.051, String(usd));
  // Doctor's own web check reads the CCD option as a valid Concordium one.
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

test('off unless CONCORDIUM_CCD=on; without a rate the CCD option is left out and USDR stays', async () => {
  const off = await challengeOf(await fetch(`${await start(await setup({ CONCORDIUM_CCD: undefined }))}${FIX}`));
  assert.deepEqual(off.accepts.filter((a) => a.network === CONCORDIUM_MAINNET).map((a) => a.asset), ['USDR']);
  const down = await challengeOf(await fetch(`${await start(await setup({ CONCORDIUM_WALLET_PROXY: await walletProxy(503) }))}${FIX}`));
  assert.deepEqual(down.accepts.filter((a) => a.network === CONCORDIUM_MAINNET).map((a) => a.asset), ['USDR']);
  assert.ok(down.accepts.some((a) => a.network === BASE));
  assert.equal(createCcd({ env: { CONCORDIUM_CCD: 'on' } }).enabled, false, 'no Concordium option, no CCD');
});

test('the MCP tools keep their fixed accepts[] (no CCD); a stale rate is dropped after a day', async () => {
  const env = await setup();
  assert.equal(paymentConfig(env).fixAccepts.some((a) => a.price?.asset === 'CCD'), false);
  let t = 0;
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return t > 0 ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(RATE)); };
  const ccd = createCcd({ env: { ...env, CONCORDIUM_EUR_PER_USD: '1' }, fetchImpl, now: () => t });
  assert.deepEqual(await ccd.priceFor(0.05), { amount: '18000000', asset: 'CCD', extra: { decimals: 6 } }, 'at 1 euro per dollar: 17.6 → 18 CCD');
  t = 30 * 60_000;
  await ccd.priceFor(0.05);
  assert.equal(calls.length, 1, 'kept for an hour');
  t = 2 * 60 * 60_000;
  assert.equal((await ccd.priceFor(0.05)).amount, '18000000', 'a failed refresh keeps the last rate');
  t = 25 * 60 * 60_000;
  assert.equal(await ccd.priceFor(0.05), null, 'older than a day: no CCD price');
  assert.equal(ccd.usdPerCcd(), null);
});

test('CONCORDIUM_TOKEN=off: CCD in the token\'s place on the 402; no Concordium option for the MCP tools; with CCD off, none at all', async () => {
  const off = await challengeOf(await fetch(`${await start(await setup({ CONCORDIUM_TOKEN: 'off' }))}${FIX}`));
  assert.deepEqual(off.accepts.filter((a) => a.network === CONCORDIUM_MAINNET).map((a) => [a.asset, a.amount]), [['CCD', '16000000']]);
  assert.equal(off.accepts[0].network, BASE, 'Base stays first');
  const none = await challengeOf(await fetch(`${await start(await setup({ CONCORDIUM_TOKEN: 'off', CONCORDIUM_CCD: undefined }))}${FIX}`));
  assert.equal(none.accepts.some((a) => a.network === CONCORDIUM_MAINNET), false);
  assert.ok(none.accepts.some((a) => a.network === BASE));
  const env = await setup({ CONCORDIUM_TOKEN: 'off' });
  assert.equal(withoutOffTokens(paymentConfig(env).fixAccepts).some((a) => a.network === CONCORDIUM_MAINNET), false);
  assert.equal(withoutOffTokens(paymentConfig(await setup()).fixAccepts).some((a) => a.network === CONCORDIUM_MAINNET), true, 'unset: the token stays');
});
