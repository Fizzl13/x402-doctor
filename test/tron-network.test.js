// TRON (the TRON x402 SDK from BofAI): tron:728126428 and its testnets are known networks, USDT and USDD are dollar
// tokens, and the TRON-only schemes "exact_gasfree" and "exact_permit" are known there (unknown anywhere else).
// Before 6 Nov 2026 a valid TRON offer (dTelecom's USDT one) read as an unknown network with an unknown scheme.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { preflight } = require('../lib/preflight');
const { diagnose, isCustomScheme } = require('../lib/diagnose');
const { createSafeFetch } = require('../lib/safe-fetch');
const { isTronAddress, familyOf, dollarToken, NETWORKS } = require('../lib/networks');
const { RECIPES } = require('../lib/recipes');

const PAY_TO = 'TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV'; // 0x41 + twenty 0x11 bytes
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDD = 'TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz';
function seller(accept) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
      const challenge = { x402Version: 2, resource: { url: `${origin}/paid`, mimeType: 'application/json', description: 'x' }, accepts: [{ maxTimeoutSeconds: 60, ...accept }] };
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      res.end(JSON.stringify(challenge));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/paid`));
    server.unref();
  });
}
const safeFetch = createSafeFetch({ allowPrivate: true });
const tron = (over = {}) => ({ scheme: 'exact_gasfree', network: 'tron:728126428', asset: USDT, amount: '10000', payTo: PAY_TO, ...over });
const by = (r, id) => r.checks.find((c) => c.id === id);

test('TRON addresses, the tron family and its dollar tokens', () => {
  for (const a of [PAY_TO, USDT, USDD, 'TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn', 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf']) assert.equal(isTronAddress(a), true, a);
  assert.equal(isTronAddress(`${USDT.slice(0, -1)}T`), false, 'checksum');
  assert.equal(isTronAddress(USDT.toLowerCase()), false, 'base58 is case-sensitive');
  assert.equal(isTronAddress('0x1111111111111111111111111111111111111111'), false);
  assert.equal(isTronAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false, 'a Bitcoin address has another prefix');
  for (const id of ['tron:728126428', 'tron:0x2b6653dc', 'tron:mainnet', 'tron:3448148188', 'tron:nile']) assert.equal(familyOf(id), 'tron', id);
  assert.equal(NETWORKS['tron:728126428'].testnet, false);
  assert.equal(NETWORKS['tron:3448148188'].testnet, true);
  assert.deepEqual(dollarToken('tron:728126428', USDT), { symbol: 'USDT', decimals: 6, eip3009: false });
  assert.equal(dollarToken('tron:mainnet', USDD).decimals, 18);
  assert.equal(dollarToken('tron:728126428', USDT.toLowerCase()), null, 'no case-folded match on TRON');
  assert.equal(dollarToken('eip155:56', 'constructor'), null, 'only listed tokens, not object properties');
});

test('exact_gasfree and exact_permit are known schemes on TRON only', () => {
  assert.equal(isCustomScheme('exact_gasfree', 'tron:728126428'), false);
  assert.equal(isCustomScheme('exact_permit', 'tron:nile'), false);
  assert.equal(isCustomScheme('exact_gasfree', 'eip155:8453'), true);
  assert.equal(isCustomScheme('exact', 'tron:728126428'), false);
  assert.equal(isCustomScheme('mystery', 'tron:728126428'), true);
});

test('diagnose: a valid exact_gasfree USDT option has no fails or warnings', async () => {
  const r = await diagnose(await seller(tron()), { safeFetch });
  const option = r.checks.filter((c) => c.id.startsWith('accepts[0]'));
  assert.deepEqual(option.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => c.message), []);
  assert.equal(by(r, 'accepts[0]-network').status, 'pass');
  assert.equal(by(r, 'accepts[0]-payto').status, 'pass');
  assert.match(by(r, 'accepts[0]-amount').message, /0\.01 USDT, 6 decimals/);
  assert.match(by(r, 'accepts[0]-scheme').message, /GasFree/);
});

test('diagnose: TRON payTo, asset, amount and transfer method mistakes', async () => {
  const typo = await diagnose(await seller(tron({ payTo: `${PAY_TO.slice(0, -1)}W` })), { safeFetch });
  assert.equal(by(typo, 'accepts[0]-payto').status, 'fail');
  assert.match(by(typo, 'accepts[0]-payto').message, /checksum/);
  const hex = await diagnose(await seller(tron({ payTo: `41${'11'.repeat(20)}` })), { safeFetch });
  assert.match(by(hex, 'accepts[0]-payto').message, /in hex/);
  const symbol = await diagnose(await seller(tron({ asset: 'USDT' })), { safeFetch });
  assert.equal(by(symbol, 'accepts[0]-asset').status, 'fail');
  const nile = await diagnose(await seller(tron({ asset: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' })), { safeFetch });
  assert.equal(by(nile, 'accepts[0]-asset').status, 'fail');
  assert.match(by(nile, 'accepts[0]-asset').message, /Nile/);
  const amount = await diagnose(await seller(tron({ amount: '0.01' })), { safeFetch });
  assert.equal(by(amount, 'accepts[0]-amount').status, 'fail');
  const usdd = await diagnose(await seller(tron({ asset: USDD, amount: '10000000000000000' })), { safeFetch });
  assert.match(by(usdd, 'accepts[0]-amount').message, /0\.01 USDD, 18 decimals/);
  // "exact" with USDT: Permit2 is fine, EIP-3009 can't settle, no method at all is a warning.
  const permit2 = await diagnose(await seller(tron({ scheme: 'exact', extra: { assetTransferMethod: 'permit2' } })), { safeFetch });
  assert.equal(by(permit2, 'accepts[0]-extra'), undefined);
  const eip3009 = await diagnose(await seller(tron({ scheme: 'exact', extra: { assetTransferMethod: 'eip3009' } })), { safeFetch });
  assert.equal(by(eip3009, 'accepts[0]-extra').status, 'fail');
  const none = await diagnose(await seller(tron({ scheme: 'exact' })), { safeFetch });
  assert.equal(by(none, 'accepts[0]-extra').status, 'warn');
  const recipe = RECIPES.find((x) => x.match({ ...by(none, 'accepts[0]-extra'), option: 0 }));
  assert.equal(recipe.key, 'tron-option');
  assert.match(recipe.fix({ ...by(none, 'accepts[0]-extra'), option: 0 }, { accepts: [tron({ scheme: 'exact' })] }).code[0].snippet, /"assetTransferMethod": "permit2"/);
});

test('diagnose: another TRON network id is noted; gasfree on another network is an unknown scheme', async () => {
  const alias = await diagnose(await seller(tron({ network: 'tron:0x2b6653dc' })), { safeFetch });
  assert.equal(by(alias, 'accepts[0]-network').status, 'pass');
  assert.equal(by(alias, 'accepts[0]-network-id').status, 'info');
  assert.match(by(alias, 'accepts[0]-network-id').message, /tron:728126428/);
  const base = await diagnose(await seller(tron({ network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x1111111111111111111111111111111111111111' })), { safeFetch });
  assert.equal(by(base, 'accepts[0]-scheme').status, 'warn');
  assert.match(by(base, 'accepts[0]-scheme').message, /only exists on TRON/);
});

test('preflight: a TRON USDT option is a known mainnet priced in dollars, not unknown_network', async () => {
  const r = await preflight(await seller(tron()), { safeFetch });
  const codes = r.reasons.map((x) => x.code);
  assert.ok(!codes.includes('unknown_network') && !codes.includes('testnet_only') && !codes.includes('unknown_asset'), JSON.stringify(r.reasons));
  assert.deepEqual([r.options[0].network_name, r.options[0].testnet, r.options[0].asset_symbol], ['TRON', false, 'USDT']);
  const nile = await preflight(await seller(tron({ network: 'tron:3448148188', asset: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' })), { safeFetch });
  assert.ok(nile.reasons.some((x) => x.code === 'testnet_only'), JSON.stringify(nile.reasons));
});
