// The spot-buy wallet (lib/spot-wallet.js) pays x402 v1 sellers as well as v2, within the same spend cap, against a
// local fake seller. It only signs: nothing reaches a chain. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generatePrivateKey } = require('viem/accounts');
const { createSpotWallet } = require('../lib/spot-wallet');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x98fa9c8afb5c56ad27d24843cabebdd55170dbc0';

// A v1 seller: the price in the 402 body, the payment in X-PAYMENT, the network named "base".
function v1Seller(maxAmountRequired) {
  const paid = [];
  const server = http.createServer((req, res) => {
    const header = req.headers['x-payment'];
    if (!header) {
      res.writeHead(402, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ x402Version: 1, error: 'X-PAYMENT header is required', accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired, resource: `http://${req.headers.host}${req.url}`, description: 'Bitcoin price', mimeType: 'application/json', payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDC, extra: { name: 'USD Coin', version: '2' } }] }));
    }
    paid.push(JSON.parse(Buffer.from(header, 'base64').toString()));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ price: 67000 }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/price`, paid, close: () => server.close() })));
}

test('spot wallet: pays an x402 v1 seller (network "base", X-PAYMENT) within the cap', async () => {
  const seller = await v1Seller('1000');
  try {
    const wallet = createSpotWallet({ key: generatePrivateKey(), capUsd: 0.05 });
    const res = await wallet.payFetch(seller.url);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { price: 67000 });
    assert.equal(seller.paid.length, 1);
    const p = seller.paid[0];
    assert.deepEqual([p.x402Version, p.scheme, p.network], [1, 'exact', 'base']);
    assert.equal(p.payload.authorization.value, '1000');
    assert.equal(p.payload.authorization.to.toLowerCase(), PAY_TO);
    assert.equal(p.payload.authorization.from, wallet.address);
  } finally { seller.close(); }
});

test('spot wallet: a v1 price above the cap is refused before anything is signed', async () => {
  const seller = await v1Seller('2000000'); // $2.00, cap $0.05
  try {
    const wallet = createSpotWallet({ key: generatePrivateKey(), capUsd: 0.05 });
    await assert.rejects(wallet.payFetch(seller.url));
    assert.equal(seller.paid.length, 0);
  } finally { seller.close(); }
});
