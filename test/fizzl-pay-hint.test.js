// The Fizzl Pay hint in a preflight: only for network_not_offered alone, an https endpoint that takes USDC on Base
// within $1, and a network Fizzl Pay's own 402 offers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fizzlPayHint, FIZZL_PAY_NETWORKS } = require('../lib/fizzl-pay-hint');
const { routesFor } = require('../buy-server');
const { createQuotes } = require('../lib/buy/pay-url');

const XRPL = 'xrpl:0';
const only = [{ level: 'no_go', code: 'network_not_offered', message: 'No payable option on xrpl:0' }];
const base = (usd) => ({ network: 'eip155:8453', usd });

test('hint: the quote, the Fizzl Pay URL and the network, for a Base-only endpoint', () => {
  const h = fizzlPayHint({ url: 'https://seller.test/w?place=Amsterdam', method: 'GET', network: XRPL, offered: [base(0.01)], reasons: only });
  assert.equal(h.url, 'https://buy.fizzl.eu/v1/pay?url=https%3A%2F%2Fseller.test%2Fw%3Fplace%3DAmsterdam');
  assert.equal(h.how, `POST ${h.url}`);
  assert.deepEqual([h.seller_usd, h.fee_usd, h.total_usd], [0.01, 0.002, 0.012]);
  assert.match(h.note, /XRP Ledger/);
  assert.match(fizzlPayHint({ url: 'https://seller.test/q', method: 'post', network: XRPL, offered: [base(0.5)], reasons: only }).url, /&method=POST$/);
  assert.equal(fizzlPayHint({ url: 'https://seller.test/q', network: XRPL, offered: [base(0.5)], reasons: only }).fee_usd, 0.01, '2% above the minimum');
});

test('hint: none when Fizzl Pay would not pay it', () => {
  const ok = { url: 'https://seller.test/w', method: 'GET', network: XRPL, offered: [base(0.01)], reasons: only };
  assert.ok(fizzlPayHint(ok));
  assert.equal(fizzlPayHint({ ...ok, network: 'eip155:8453' }), null, 'Base itself');
  assert.equal(fizzlPayHint({ ...ok, network: 'eip155:1' }), null, 'a network Fizzl Pay does not take');
  assert.equal(fizzlPayHint({ ...ok, url: 'http://seller.test/w' }), null, 'not https');
  assert.equal(fizzlPayHint({ ...ok, url: 'https://buy.fizzl.eu/v1/buy' }), null, 'itself');
  assert.equal(fizzlPayHint({ ...ok, method: 'PUT' }), null);
  assert.equal(fizzlPayHint({ ...ok, offered: [base(1.5)] }), null, 'above the $1 cap');
  assert.equal(fizzlPayHint({ ...ok, offered: [{ network: 'eip155:137', usd: 0.01 }] }), null, 'no Base option');
  assert.equal(fizzlPayHint({ ...ok, reasons: [...only, { level: 'no_go', code: 'payto_sanctioned', message: 'x' }] }), null, 'another objection');
  assert.equal(fizzlPayHint({ ...ok, reasons: [] }), null);
});

test("hint networks are exactly the ones Fizzl Pay's 402 offers (with every network set up)", () => {
  const env = {
    AGENT_PAYOUT_WALLET: '0x1111111111111111111111111111111111111111', AGENT_PAYOUT_WALLET_SOLANA: 'ATWJ82ZyPLMjgbJ3G9Lr5QUxFgnsyTnX4dhDV3VnYw1v',
    XRPL_PAY_TO: 'r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw', ALGORAND_PAY_TO: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', STELLAR_FACILITATOR_URL: 'https://stellar.test',
    CDP_API_KEY_ID: 'test-id', CDP_API_KEY_SECRET: 'test-secret',
  };
  const accepts = routesFor(env, { quotes: createQuotes() })['POST /v1/pay'].accepts;
  const offered = new Set(accepts.map((a) => a.network));
  assert.deepEqual([...offered].sort(), Object.keys(FIZZL_PAY_NETWORKS).sort());
});
