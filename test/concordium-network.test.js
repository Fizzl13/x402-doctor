// Concordium payment options (ccd:): a known network with a Concordium account as payTo, CCD or a protocol-level
// token as asset and an atomic amount. No x402 scheme or facilitator settles Concordium payments yet (Nov 2026), so
// Doctor checks the shape and says so (preflight no_settlement_yet), instead of "unknown network" (a seller building a
// Concordium x402 challenge asked for this on 6 Nov 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { preflight } = require('../lib/preflight');
const { diagnose } = require('../lib/diagnose');
const { createSafeFetch } = require('../lib/safe-fetch');
const { isConcordiumAddress, familyOf, NETWORKS } = require('../lib/networks');
const { RECIPES } = require('../lib/recipes');

const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const PAY_TO = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB'; // a real mainnet account (checksum OK)
function seller(accept) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
      const challenge = { x402Version: 2, resource: { url: `${origin}/paid`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', maxTimeoutSeconds: 60, ...accept }] };
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      res.end(JSON.stringify(challenge));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/paid`));
    server.unref();
  });
}
const safeFetch = createSafeFetch({ allowPrivate: true });
const ccd = (over = {}) => ({ network: MAINNET, asset: 'CCD', amount: '10000', payTo: PAY_TO, ...over });
const by = (r, id) => r.checks.find((c) => c.id === id);

test('Concordium accounts and the concordium family', () => {
  assert.equal(isConcordiumAddress(PAY_TO), true);
  assert.equal(isConcordiumAddress(`${MAINNET}:${PAY_TO}`), true, 'the CAIP-10 form');
  assert.equal(isConcordiumAddress(`${PAY_TO.slice(0, -1)}C`), false, 'checksum');
  assert.equal(isConcordiumAddress('0x1111111111111111111111111111111111111111'), false);
  assert.equal(familyOf(MAINNET), 'concordium');
  assert.equal(NETWORKS[MAINNET].testnet, false);
  assert.equal(NETWORKS[TESTNET].testnet, true);
});

test('diagnose: a CCD option is checked as Concordium, with the settlement note', async () => {
  const r = await diagnose(await seller(ccd()), { safeFetch });
  assert.equal(by(r, 'accepts[0]-network').status, 'pass');
  assert.equal(by(r, 'accepts[0]-payto').status, 'pass');
  assert.match(by(r, 'accepts[0]-amount').message, /0\.01 CCD, 6 decimals/);
  assert.equal(by(r, 'accepts[0]-settlement').status, 'info');
  assert.deepEqual(r.checks.filter((c) => c.id.startsWith('accepts[0]') && (c.status === 'fail' || c.status === 'warn')).map((c) => c.message), []);
});

test('diagnose: a PLT option shows its amount with extra.decimals; mistakes fail', async () => {
  const plt = await diagnose(await seller(ccd({ asset: 'EURR', amount: '2500000', extra: { decimals: 6 } })), { safeFetch });
  assert.match(by(plt, 'accepts[0]-amount').message, /2\.5 EURR, 6 decimals/);
  const noDecimals = await diagnose(await seller(ccd({ asset: 'EURR', amount: '2500000' })), { safeFetch });
  assert.equal(by(noDecimals, 'accepts[0]-amount').status, 'pass');
  assert.doesNotMatch(by(noDecimals, 'accepts[0]-amount').message, /decimals\)/);
  const typo = await diagnose(await seller(ccd({ payTo: `${PAY_TO.slice(0, -1)}C` })), { safeFetch });
  assert.match(by(typo, 'accepts[0]-payto').message, /checksum/);
  const evm = await diagnose(await seller(ccd({ payTo: '0x1111111111111111111111111111111111111111' })), { safeFetch });
  assert.equal(by(evm, 'accepts[0]-payto').status, 'fail');
  const asset = await diagnose(await seller(ccd({ asset: 'Euro stablecoin' })), { safeFetch });
  assert.equal(by(asset, 'accepts[0]-asset').status, 'fail');
  assert.equal(RECIPES.find((x) => x.match({ ...by(asset, 'accepts[0]-asset'), option: 0 })).key, 'concordium-option');
  const amount = await diagnose(await seller(ccd({ amount: '0.01' })), { safeFetch });
  assert.equal(by(amount, 'accepts[0]-amount').status, 'fail');
});

test('preflight: a Concordium option is no_settlement_yet on a known mainnet, not unknown_network', async () => {
  const r = await preflight(await seller(ccd()), { safeFetch });
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('no_settlement_yet'), JSON.stringify(r.reasons));
  assert.ok(!codes.includes('unknown_network') && !codes.includes('unknown_asset'), JSON.stringify(r.reasons));
  assert.deepEqual([r.options[0].network_name, r.options[0].testnet], ['Concordium', false]);
  assert.equal(r.verdict, 'caution');
});
