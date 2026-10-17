// The Doctor's own paid routes in USDC on Stellar next to Base: only with a Stellar facilitator configured
// (STELLAR_FACILITATOR_KEY for OpenZeppelin's, a mock here), paid to Frits's account unless STELLAR_PAY_TO says else.

process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');
const { paymentConfig } = require('../lib/paid-api');

const BASE = 'eip155:8453';
const STELLAR = 'stellar:pubnet';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const FRITS = 'GCH2J5UAY24YNKA65MPAATVKWRCZZRZNF3JZKYYS5MIBZPG6U7WJ6CDQ';
const OTHER = 'GABUG2A7VT3DRJ32WJB4EVSVYRKBZBMBU5GUIJOO5ESUV5UQEYNCPSVR';
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

const servers = [];
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
const supported = (kinds, seen = []) => (req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.endsWith('/supported') ? { kinds, extensions: [], signers: {} } : { isValid: false }));
};
test.after(() => servers.forEach((s) => s.close()));

test('paymentConfig: Stellar only with a Stellar facilitator; Frits\'s account by default, STELLAR_PAY_TO or "off" otherwise', () => {
  const base = { AGENT_PAYOUT_WALLET: PAY_TO_BASE };
  assert.equal(paymentConfig(base).accepts.some((a) => a.network === STELLAR), false);
  assert.equal(paymentConfig({ ...base, STELLAR_PAY_TO: OTHER }).accepts.some((a) => a.network === STELLAR), false, 'no facilitator, no option');
  const s = paymentConfig({ ...base, STELLAR_FACILITATOR_KEY: 'k' }).accepts.find((x) => x.network === STELLAR);
  assert.equal(s.payTo, FRITS);
  assert.equal(s.price, '$0.01');
  assert.equal(paymentConfig({ ...base, STELLAR_FACILITATOR_KEY: 'k', STELLAR_PAY_TO: ` ${OTHER} ` }).accepts.find((x) => x.network === STELLAR).payTo, OTHER);
  assert.equal(paymentConfig({ ...base, STELLAR_FACILITATOR_KEY: 'k', STELLAR_PAY_TO: 'off' }).accepts.some((a) => a.network === STELLAR), false);
});

test('402 offers USDC (the Stellar Asset Contract, 7 decimals) on Stellar with sponsored fees; the key goes to the facilitator', async () => {
  // The PayAI mock also claims Stellar, without sponsored fees: OpenZeppelin's must win.
  const payai = await listen(supported([
    { x402Version: 2, scheme: 'exact', network: BASE },
    { x402Version: 2, scheme: 'exact', network: STELLAR, extra: { areFeesSponsored: false } },
  ]));
  const seen = [];
  const oz = await listen(supported([{ x402Version: 2, scheme: 'exact', network: STELLAR, extra: { areFeesSponsored: true } }], seen));
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: payai, STELLAR_FACILITATOR_URL: oz, STELLAR_FACILITATOR_KEY: 'test-key' };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const res = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent('https://example.com/')}`);
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
  const stellar = challenge.accepts.find((a) => a.network === STELLAR);
  assert.ok(stellar, `no Stellar option in ${JSON.stringify(challenge.accepts.map((a) => a.network))}`);
  assert.equal(stellar.asset, USDC_SAC);
  assert.equal(stellar.amount, '10000', '$0.001 at 7 decimals');
  assert.equal(stellar.payTo, FRITS);
  assert.equal(stellar.extra.areFeesSponsored, true);
  assert.ok(challenge.accepts.some((a) => a.network === BASE), 'Base stays');
  assert.ok(seen.some((r) => r.url.endsWith('/supported') && r.auth === 'Bearer test-key'));
});

test('usage log: a Stellar USDC payment is named "stellar" and counted in dollars (7 decimals)', () => {
  const { usdOf } = require('../lib/usage-log');
  assert.equal(usdOf({ network: STELLAR, asset: USDC_SAC, amount: '10000' }), 0.001);
  assert.equal(usdOf({ network: BASE, amount: '1000' }), 0.001);
});
