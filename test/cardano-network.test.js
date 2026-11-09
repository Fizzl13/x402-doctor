// Cardano payment options: x402's exact scheme on Cardano (specs/schemes/exact/scheme_exact_cardano.md, @x402/cardano).
// Known networks cardano:mainnet/preprod/preview and their CIP-34 aliases, a Shelley payTo (bech32, the network in its
// header), "lovelace" or a native token (policyId.assetNameHex; USDM is a dollar token), an atomic amount, and the
// optional transfer method and confirmation policy. ADA is not a dollar stablecoin, so the preflight says
// priced_in_ada (max_usd unchecked) instead of "unknown network"; USDM is priced in dollars.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { preflight } = require('../lib/preflight');
const { diagnose } = require('../lib/diagnose');
const { createSafeFetch } = require('../lib/safe-fetch');
const { cardanoAddress, familyOf, dollarToken, NETWORKS } = require('../lib/networks');
const { RECIPES } = require('../lib/recipes');

// CIP-19's test vectors: a base, an enterprise, a script-enterprise and a pointer address on mainnet, and a testnet base.
const BASE = 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';
const ENTERPRISE = 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8';
const SCRIPT = 'addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx';
const POINTER = 'addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k';
const TEST_BASE = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';
const USDM = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d';
const T_USDM = 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d';

function seller(accept) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
      const challenge = { x402Version: 2, resource: { url: `${origin}/paid`, mimeType: 'application/json', description: 'x' }, accepts: [{ scheme: 'exact', maxTimeoutSeconds: 600, ...accept }] };
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      res.end(JSON.stringify(challenge));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/paid`));
    server.unref();
  });
}
const safeFetch = createSafeFetch({ allowPrivate: true });
const ada = (over = {}) => ({ network: 'cardano:mainnet', asset: USDM, amount: '10000', payTo: BASE, extra: {}, ...over });
const by = (r, id) => r.checks.find((c) => c.id === id);
const problems = (r) => r.checks.filter((c) => c.id.startsWith('accepts[0]') && (c.status === 'fail' || c.status === 'warn')).map((c) => `${c.id}: ${c.message}`);

test('Cardano addresses (CIP-19) and the cardano family, with the CIP-34 aliases', () => {
  assert.deepEqual(cardanoAddress(BASE), { mainnet: true, script: false, kind: 'base' });
  assert.deepEqual(cardanoAddress(ENTERPRISE), { mainnet: true, script: false, kind: 'enterprise' });
  assert.deepEqual(cardanoAddress(SCRIPT), { mainnet: true, script: true, kind: 'enterprise' });
  assert.deepEqual(cardanoAddress(POINTER), { mainnet: true, script: false, kind: 'pointer' });
  assert.deepEqual(cardanoAddress(TEST_BASE), { mainnet: false, script: false, kind: 'base' });
  assert.equal(cardanoAddress(`${ENTERPRISE.slice(0, -1)}9`), null, 'checksum');
  assert.equal(cardanoAddress('stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw'), null, 'a stake address pays nothing');
  assert.equal(cardanoAddress(BASE.toUpperCase()), null);
  assert.equal(cardanoAddress('0x1111111111111111111111111111111111111111'), null);
  for (const id of ['cardano:mainnet', 'cardano:preprod', 'cardano:preview', 'cip34:1-764824073', 'cip34:0-1', 'cip34:0-2']) assert.equal(familyOf(id), 'cardano', id);
  assert.equal(NETWORKS['cardano:mainnet'].testnet, false);
  assert.equal(NETWORKS['cardano:preprod'].testnet, true);
  assert.equal(NETWORKS['cip34:1-764824073'], NETWORKS['cardano:mainnet'], 'the alias is the same network');
  assert.deepEqual(dollarToken('cardano:mainnet', USDM), { symbol: 'USDM', decimals: 6 });
  assert.equal(dollarToken('cardano:mainnet', T_USDM), null, 'preprod USDM is not mainnet USDM');
});

test('diagnose: a USDM option on mainnet passes, with the settlement note (the buyer also needs ADA)', async () => {
  const r = await diagnose(await seller(ada()), { safeFetch });
  assert.equal(by(r, 'accepts[0]-network').status, 'pass');
  assert.match(by(r, 'accepts[0]-payto').message, /base address on mainnet/);
  assert.match(by(r, 'accepts[0]-amount').message, /0\.01 USDM, 6 decimals/);
  assert.equal(by(r, 'accepts[0]-settlement').status, 'info');
  assert.match(by(r, 'accepts[0]-settlement').message, /@x402\/cardano/);
  assert.match(by(r, 'accepts[0]-settlement').message, /paying in USDM also needs some ADA/);
  assert.deepEqual(problems(r), []);
});

test('diagnose: ADA in lovelace, a script payee, the masumi method and a CIP-34 alias', async () => {
  const lovelace = await diagnose(await seller(ada({ asset: 'lovelace', amount: '2000000', payTo: SCRIPT, extra: { assetTransferMethod: 'script', confirmationPolicy: { l1Confirmations: 0 } } })), { safeFetch });
  assert.match(by(lovelace, 'accepts[0]-amount').message, /2 ADA, 6 decimals/);
  assert.match(by(lovelace, 'accepts[0]-payto').message, /script address/);
  assert.match(by(lovelace, 'accepts[0]-settlement').message, /seller's own contract/);
  assert.deepEqual(problems(lovelace), []);
  const masumi = await diagnose(await seller(ada({ extra: { assetTransferMethod: 'masumi' } })), { safeFetch });
  assert.match(by(masumi, 'accepts[0]-settlement').message, /vested_pay escrow/);
  const alias = await diagnose(await seller(ada({ network: 'cip34:1-764824073' })), { safeFetch });
  assert.equal(by(alias, 'accepts[0]-network').status, 'pass');
  assert.equal(by(alias, 'accepts[0]-network-id').status, 'info');
  assert.match(by(alias, 'accepts[0]-network-id').hint, /cardano:mainnet/);
  const preprod = await diagnose(await seller(ada({ network: 'cardano:preprod', payTo: TEST_BASE, asset: T_USDM })), { safeFetch });
  assert.deepEqual(problems(preprod), []);
});

test('diagnose: mistakes fail or warn, and the asset ones have a recipe', async () => {
  const wrongNet = await diagnose(await seller(ada({ payTo: TEST_BASE })), { safeFetch });
  assert.match(by(wrongNet, 'accepts[0]-payto').message, /testnet address .* but the network is Cardano/);
  const typo = await diagnose(await seller(ada({ payTo: `${ENTERPRISE.slice(0, -1)}9` })), { safeFetch });
  assert.match(by(typo, 'accepts[0]-payto').message, /checksum or length/);
  const byron = await diagnose(await seller(ada({ payTo: 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi' })), { safeFetch });
  assert.match(by(byron, 'accepts[0]-payto').message, /Byron/);
  for (const [asset, re] of [['ADA', /"lovelace"/], [USDM.replace('.', ''), /without the dot/], ['USDM', /policyId\.assetNameHex/]]) {
    const r = await diagnose(await seller(ada({ asset })), { safeFetch });
    assert.equal(by(r, 'accepts[0]-asset').status, 'fail', asset);
    assert.match(by(r, 'accepts[0]-asset').message, re, asset);
    assert.equal(RECIPES.find((x) => x.match({ ...by(r, 'accepts[0]-asset'), option: 0 }))?.key, 'cardano-option', asset);
  }
  const otherNet = await diagnose(await seller(ada({ asset: T_USDM })), { safeFetch });
  assert.match(by(otherNet, 'accepts[0]-asset').message, /USDM on Cardano Preprod, but the network is Cardano/);
  const unknownToken = await diagnose(await seller(ada({ asset: `${'ab'.repeat(28)}.${'cd'.repeat(4)}` })), { safeFetch });
  assert.equal(by(unknownToken, 'accepts[0]-asset').status, 'warn');
  const small = await diagnose(await seller(ada({ asset: 'lovelace', amount: '500000' })), { safeFetch });
  assert.equal(by(small, 'accepts[0]-min-ada').status, 'warn');
  const fast = await diagnose(await seller(ada({ maxTimeoutSeconds: 60 })), { safeFetch });
  assert.equal(by(fast, 'accepts[0]-timeout').status, 'warn');
  const method = await diagnose(await seller(ada({ extra: { assetTransferMethod: 'eip3009' } })), { safeFetch });
  assert.equal(by(method, 'accepts[0]-extra').status, 'fail');
  const policy = await diagnose(await seller(ada({ extra: { confirmationPolicy: { l1Confirmations: 50 } } })), { safeFetch });
  assert.equal(by(policy, 'accepts[0]-confirmations').status, 'fail');
  const zero = await diagnose(await seller(ada({ amount: '0' })), { safeFetch });
  assert.equal(by(zero, 'accepts[0]-amount').status, 'fail');
  const upto = await diagnose(await seller(ada({ scheme: 'upto' })), { safeFetch });
  assert.equal(by(upto, 'accepts[0]-scheme').status, 'warn');
});

test('preflight: USDM is priced in dollars; ADA is priced_in_ada; neither is an unknown network', async () => {
  const usdm = await preflight(await seller(ada()), { safeFetch, maxUsd: 0.05 });
  const codes = (r) => r.reasons.map((x) => x.code);
  assert.ok(!codes(usdm).includes('unknown_network'), JSON.stringify(usdm.reasons));
  assert.ok(!codes(usdm).includes('unknown_asset'), JSON.stringify(usdm.reasons));
  assert.equal(usdm.options.find((o) => o.network === 'cardano:mainnet').usd, 0.01);
  const pricey = await preflight(await seller(ada({ amount: '100000' })), { safeFetch, maxUsd: 0.05 });
  assert.ok(codes(pricey).includes('over_budget'), 'max_usd is checked for USDM');
  const lovelace = await preflight(await seller(ada({ asset: 'lovelace', amount: '2000000' })), { safeFetch });
  assert.ok(codes(lovelace).includes('priced_in_ada'), JSON.stringify(lovelace.reasons));
  assert.ok(!codes(lovelace).includes('unknown_network'));
  assert.match(lovelace.reasons.find((x) => x.code === 'priced_in_ada').message, /\(2 ADA\)/);
});
