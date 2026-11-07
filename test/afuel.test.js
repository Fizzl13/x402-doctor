// $AFUEL as an extra Solana payment option (lib/afuel.js): on the HTTP paywall next to USDC on Solana, discounted,
// and absent unless AFUEL_PAYMENTS=on or while there is no fresh AFUEL price.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { AFUEL_MINT, afuelAmount, createAfuel, curvePriceSol } = require('../lib/afuel');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const PAY_TO_SOLANA = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const servers = [];
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  servers.push(s);
});
test.after(() => servers.forEach((s) => s.close()));

let facilitatorUrl;
const settled = [];
test.before(async () => {
  facilitatorUrl = await listen(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/supported')) {
      return res.end(JSON.stringify({
        kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }, { x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } }],
        extensions: [],
        signers: {},
      }));
    }
    let raw = '';
    for await (const c of req) raw += c;
    const { paymentRequirements } = JSON.parse(raw);
    settled.push({ path: req.url, requirements: paymentRequirements });
    if (req.url.endsWith('/verify')) return res.end(JSON.stringify({ isValid: true, payer: 'Payer111111111111111111111111111111111111111' }));
    res.end(JSON.stringify({ success: true, transaction: '5xTx', network: SOLANA, payer: 'Payer111111111111111111111111111111111111111' }));
  });
});

async function start(extraEnv) {
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, AGENT_PAYOUT_WALLET_SOLANA: PAY_TO_SOLANA, FACILITATOR_URL: facilitatorUrl, DOCTOR_WARM_BAZAAR_INDEX: '0', ...extraEnv };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}

const challengeOf = async (res) => JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));

test('afuelAmount and curvePriceSol', () => {
  assert.equal(afuelAmount(0.01, 0.00002, 25), '375000000');
  const data = Buffer.alloc(49);
  data.writeBigUInt64LE(1_000_000_000n * 10n ** 6n, 8);
  data.writeBigUInt64LE(30n * 10n ** 9n, 16);
  assert.equal(curvePriceSol(data), 30 / 1e9);
});

test('without AFUEL_PAYMENTS=on the 402 has no AFUEL option', async () => {
  const api = await start({ AFUEL_USD_PRICE: '0.00002' });
  const { accepts } = await challengeOf(await fetch(`${api}/api/v1/diagnose?url=${encodeURIComponent('https://example.com/paid')}`));
  assert.ok(accepts.length >= 2);
  assert.ok(!accepts.some((a) => a.asset === AFUEL_MINT));
});

test('with AFUEL_PAYMENTS=on every paid route offers AFUEL on Solana after USDC, discounted, and accepts it', async () => {
  const api = await start({ AFUEL_PAYMENTS: 'on', AFUEL_USD_PRICE: '0.00002' });
  const url = `${api}/api/v1/diagnose?url=${encodeURIComponent('https://example.com/paid')}`;
  const { accepts } = await challengeOf(await fetch(url));
  const usdc = accepts.find((a) => a.asset === USDC_SOLANA);
  const i = accepts.findIndex((a) => a.asset === AFUEL_MINT);
  assert.ok(i > 0, 'AFUEL offered');
  const token = accepts[i];
  assert.equal(accepts[i - 1], usdc, 'right after USDC on Solana');
  assert.equal(token.network, SOLANA);
  assert.equal(token.payTo, PAY_TO_SOLANA);
  assert.equal(token.extra.feePayer, '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4');
  // 25% off the USDC price, at $0.00002 per AFUEL (6 decimals both).
  assert.equal(token.amount, afuelAmount(Number(usdc.amount) / 1e6, 0.00002, 25));

  const preflight = await challengeOf(await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent('https://example.com/paid')}`));
  assert.ok(preflight.accepts.some((a) => a.asset === AFUEL_MINT), 'preflight too');

  settled.length = 0;
  const payment = Buffer.from(JSON.stringify({ x402Version: 2, accepted: token, payload: { transaction: 'AAAA' } })).toString('base64');
  const paid = await fetch(url, { headers: { 'payment-signature': payment } });
  assert.notEqual(paid.status, 402);
  const verify = settled.find((s) => s.path.endsWith('/verify'));
  assert.equal(verify.requirements.asset, AFUEL_MINT);
  assert.equal(verify.requirements.amount, token.amount);
});

test('no AFUEL price without a live source', async () => {
  const afuel = createAfuel({ env: { AFUEL_PAYMENTS: 'on' }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await afuel.priceFor(0.01), null);
});
