// Fizzl Pay on Concordium (private until the release): USDR at the quote's price, and CCD at the chain's rate.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { routesFor } = require('../buy-server');
const { createQuotes } = require('../lib/buy/pay-url');
const { CONCORDIUM_MAINNET } = require('../lib/concordium-pay');

const OWNER = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J';
const RATE = { microGTUPerEuro: { denominator: 35769558433, numerator: 12608753779068010496 } };

test('pay on Concordium: USDR at the quote, CCD after it at the chain rate, only from $0.05 and only when set up', async () => {
  const proxy = await new Promise((r) => { const s = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(RATE)); }).listen(0, '127.0.0.1', () => r(s)); });
  try {
    const quotes = createQuotes();
    quotes.set({ url: 'https://seller.test/a', method: 'GET', seller_usd: 0.1, fee_usd: 0.002, total_usd: 0.102 });
    quotes.set({ url: 'https://seller.test/b', method: 'GET', seller_usd: 0.01, fee_usd: 0.002, total_usd: 0.012 });
    const ctx = (u) => ({ adapter: { getUrl: () => `/v1/pay?url=${encodeURIComponent(u)}` } });
    const env = { AGENT_PAYOUT_WALLET: '0x1111111111111111111111111111111111111111', CONCORDIUM_PAY_TO: OWNER, CONCORDIUM_FACILITATOR_URL: 'https://ccd.test', CONCORDIUM_WALLET_PROXY: `http://127.0.0.1:${proxy.address().port}`, CONCORDIUM_CCD: 'on', XRPL_XRP: 'off' };
    const ccdOpts = routesFor(env, { quotes })['POST /v1/pay'].accepts.filter((a) => a.network === CONCORDIUM_MAINNET);
    assert.equal(ccdOpts.length, 2);
    assert.deepEqual(ccdOpts[0].price(ctx('https://seller.test/a')), { amount: '102000', asset: 'USDR', extra: { decimals: 6 } });
    const ccdPrice = await ccdOpts[1].price(ctx('https://seller.test/a'));
    assert.equal(ccdPrice.asset, 'CCD');
    assert.ok(Number(ccdPrice.amount) > 0);
    assert.equal(ccdOpts[0].price(ctx('https://seller.test/b')), null, 'under $0.05: not on Concordium (the sponsored fee)');
    assert.equal(await ccdOpts[1].price(ctx('https://seller.test/b')), null);
    assert.equal(ccdOpts[0].price(ctx('https://never.test/x')), null);
    assert.equal(routesFor({ ...env, CONCORDIUM_CCD: 'off' }, { quotes })['POST /v1/pay'].accepts.filter((a) => a.network === CONCORDIUM_MAINNET).length, 1, 'USDR only');
    assert.equal(routesFor({ ...env, CONCORDIUM_PAY_TO: '' }, { quotes })['POST /v1/pay'].accepts.filter((a) => a.network === CONCORDIUM_MAINNET).length, 0);
  } finally {
    proxy.close();
  }
});
