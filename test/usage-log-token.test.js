// The usage log values a payment in a registered token ($AFUEL) at the token's live price, not as if its base units
// were USDC: 2,568 AFUEL is about $0.0075, not $2,568.
const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentOf, setTokenPrice, usdOf } = require('../lib/usage-log');

const MINT = '8Qj1i5Q8DJ1HJW2rEpdzED47jNi2f5XvaqwykqQQpump';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

test('a registered token is valued at its live price, and without one its usd is null', () => {
  let price = 0.00000292;
  setTokenPrice(MINT, 'AFUEL', () => price);
  const accepted = { scheme: 'exact', network: SOLANA, asset: MINT, amount: '2568009313', payTo: 'x' };
  assert.ok(Math.abs(usdOf(accepted) - 0.0075) < 0.0001);
  const req = { headers: { 'payment-signature': b64({ x402Version: 2, accepted, payload: {} }) } };
  const res = { locals: {}, getHeader: (h) => (h === 'PAYMENT-RESPONSE' ? b64({ success: true, network: SOLANA, payer: 'P', transaction: 'T' }) : undefined) };
  const p = paymentOf(req, res);
  assert.equal(p.token, 'AFUEL');
  assert.ok(Math.abs(p.token_amount - 2568.009313) < 1e-6);
  assert.ok(p.usd < 0.01);
  price = null;
  assert.equal(usdOf(accepted), null, 'no price: unknown, never the base units as dollars');
  assert.equal(usdOf({ network: SOLANA, asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '10000' }), 0.01, 'USDC as before');
});
