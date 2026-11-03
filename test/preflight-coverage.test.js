// What a preflight verdict covered and what it didn't (lib/preflight-coverage.js), pure and through preflight().
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { coverageOf } = require('../lib/preflight-coverage');
const { preflight } = require('../lib/preflight');
const { createSafeFetch } = require('../lib/safe-fetch');

const not = (cov, check) => cov.not_checked.find((x) => x.check === check);
const checks = (list) => list.map((x) => x.check);

test('a new seller with a readable 402: the terms are checked; no track record or purchases is no_data, not a failure', () => {
  const cov = coverageOf({ challenge: true, price: 0.01, maxUsd: 0.05, advertised: 0.01, screen: { screened: 1, listed: [] }, trustIndexGiven: true, track: null, paymentsGiven: true, onchain: null, countable: true, deliveryGiven: true, spotGiven: true, outcomesGiven: true, https: true });
  for (const c of ['payment_terms', 'sanctions', 'payout_address', 'budget', 'advertised_price', 'https']) assert.ok(checks(cov.checked).includes(c), c);
  for (const c of ['track_record', 'onchain_payments', 'purchases']) assert.equal(not(cov, c).because, 'no_data', c);
  assert.equal(cov.checks_complete, true);
});

test('go never covers the buyer\'s own request or signature: both always out of scope, pointing to what checks them', () => {
  const cov = coverageOf({ challenge: true, price: 0.01, https: true });
  assert.match(not(cov, 'your_request').why, /delivery-check/);
  assert.match(not(cov, 'your_signature').why, /presign-guard/);
});

test('no max_usd names the parameter to send; a sanctions list that could not load makes checks_complete false', () => {
  const cov = coverageOf({ challenge: true, price: 0.01, screen: { unavailable: true }, https: true });
  assert.deepEqual([not(cov, 'budget').because, not(cov, 'budget').send], ['not_sent', 'max_usd']);
  assert.equal(not(cov, 'sanctions').because, 'unavailable');
  assert.equal(cov.checks_complete, false);
});

test('no 402 read: an endpoint that checks its input asks for the body; otherwise the terms were unavailable', () => {
  assert.equal(not(coverageOf({ needsInput: true, price: null }), 'payment_terms').send, 'body');
  assert.equal(not(coverageOf({ price: null }), 'payment_terms').because, 'unavailable');
});

test('a bait or price check that was asked but did not answer is unavailable; one that was not asked is left out', () => {
  const asked = coverageOf({ challenge: true, price: 0.01, lureEnabled: true, judgement: null, priceCheckEnabled: true, priceCmp: null });
  assert.equal(not(asked, 'bait').because, 'unavailable');
  assert.equal(not(asked, 'price_comparison').because, 'unavailable');
  const off = coverageOf({ challenge: true, price: 0.01 });
  assert.equal(not(off, 'bait'), undefined);
  assert.ok(!checks(off.checked).includes('track_record'), 'a dependency the caller did not give is not listed');
});

test('preflight() carries checked, not_checked and checks_complete', async () => {
  const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
    const challenge = { x402Version: 2, resource: { url: `http://127.0.0.1:${server.address().port}/paid`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await preflight(`http://127.0.0.1:${server.address().port}/paid`, { safeFetch: createSafeFetch({ allowPrivate: true }), maxUsd: 0.05 });
    assert.equal(r.verdict, 'go');
    assert.ok(checks(r.checked).includes('payment_terms'));
    assert.ok(checks(r.checked).includes('budget'));
    assert.equal(not(r, 'your_request').because, 'out_of_scope');
    assert.equal(typeof r.checks_complete, 'boolean');
  } finally {
    server.close();
  }
});
