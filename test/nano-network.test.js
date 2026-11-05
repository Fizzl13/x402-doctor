// Nano (nano:mainnet, @x402nano/exact): a mainnet priced in its own coin XNO, not "testnet only" and not an unknown
// token (a seller, pursekeeper.dev, pointed out both on 4 Nov 2026). A network x402 Doctor doesn't know is called
// unknown, not a testnet.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { preflight } = require('../lib/preflight');
const { diagnose } = require('../lib/diagnose');
const { createSafeFetch } = require('../lib/safe-fetch');
const { isNanoAddress, isNanoFormat, nanoPublicKey, familyOf } = require('../lib/networks');
const { blake2b } = require('../lib/blake2b');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
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
const nano = (over = {}) => ({ network: 'nano:mainnet', asset: 'XNO', amount: '1000000000000000000000000000', payTo: PAY_TO, ...over });

test('Nano accounts and the nano family', () => {
  assert.equal(isNanoAddress(PAY_TO), true);
  assert.equal(isNanoAddress(PAY_TO.replace('nano_', 'xrb_')), true);
  assert.equal(isNanoAddress(PAY_TO.slice(0, -1)), false);
  assert.equal(isNanoAddress(PAY_TO.replace('nano_1', 'nano_2')), false);
  assert.equal(isNanoAddress('0x1111111111111111111111111111111111111111'), false);
  assert.equal(familyOf('nano:mainnet'), 'nano');
});

test('preflight: XNO on nano:mainnet is priced_in_xno, not testnet_only or unknown_asset', async () => {
  const r = await preflight(await seller(nano()), { safeFetch });
  const codes = r.reasons.map((x) => x.code);
  assert.deepEqual(codes, ['priced_in_xno'], JSON.stringify(r.reasons));
  assert.match(r.reasons[0].message, /0\.001 XNO/);
  assert.equal(r.verdict, 'caution');
  assert.deepEqual([r.options[0].network_name, r.options[0].testnet, r.options[0].payable], ['Nano', false, true]);
});

test('diagnose: Nano payTo, asset and amount are checked as Nano', async () => {
  const good = await diagnose(await seller(nano()), { safeFetch });
  const by = (r, id) => r.checks.find((c) => c.id === id);
  assert.equal(by(good, 'accepts[0]-network').status, 'pass');
  assert.equal(by(good, 'accepts[0]-payto').status, 'pass');
  assert.match(by(good, 'accepts[0]-amount').message, /0\.001 XNO/);
  const bad = await diagnose(await seller(nano({ payTo: '0x1111111111111111111111111111111111111111', amount: '0.001' })), { safeFetch });
  assert.equal(by(bad, 'accepts[0]-payto').status, 'fail');
  assert.equal(by(bad, 'accepts[0]-amount').status, 'fail');
});

test('preflight: a network x402 Doctor does not know is unknown_network, not testnet_only', async () => {
  const r = await preflight(await seller({ network: 'mystery:main', asset: 'MYS', amount: '5', payTo: 'someone' }), { safeFetch });
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('unknown_network'), JSON.stringify(r.reasons));
  assert.ok(!codes.includes('testnet_only') && !codes.includes('unknown_asset'));
  // A known testnet is still testnet_only.
  const t = await preflight(await seller({ network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '10000', payTo: '0x1111111111111111111111111111111111111111', extra: { name: 'USDC', version: '2' } }), { safeFetch });
  assert.ok(t.reasons.some((x) => x.code === 'testnet_only'), JSON.stringify(t.reasons));
});

test('Nano account checksum: the spec\'s accounts pass, a one-character typo fails (pursekeeper.dev, 5 Nov 2026)', () => {
  // From the test vectors of the exact scheme on Nano (x402-foundation/x402#3432): payTo decodes to this key.
  assert.equal(nanoPublicKey(PAY_TO), '776E05C7A2D3B5887DCE7EB2831078FCCDB9AED77EC6B27CDC05550B07D744A3');
  for (const a of ['nano_3ah94brzdm3e5nzzpstzcyxgkddt3ydgzi4478jshawrh7gtof5sb8twxqxt', 'nano_3qgmh14nwztqw4wmcdzy4xpqeejey68chx6nciczwn9abji7ihhum9qtpmdr', 'nano_1i3y944esngqw6wb6ia68dotj4yuqctch9kx8ct65twt8ewi4rdcfgax7ggf', 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3']) {
    assert.equal(isNanoAddress(a), true, a);
  }
  const typo = `${PAY_TO.slice(0, 20)}${PAY_TO[20] === 'a' ? 'b' : 'a'}${PAY_TO.slice(21)}`;
  assert.equal(isNanoFormat(typo), true);
  assert.equal(isNanoAddress(typo), false);
  const badCheck = `${PAY_TO.slice(0, -1)}${PAY_TO.endsWith('1') ? '3' : '1'}`;
  assert.equal(isNanoAddress(badCheck), false, 'last character changed');
  // BLAKE2b (RFC 7693, appendix A): "abc" with a 64-byte digest.
  assert.equal(blake2b(Buffer.from('abc'), 64).toString('hex').slice(0, 32), 'ba80a53f981c4d0d6a2797b69f12f6e9');
});

test('diagnose: a Nano payTo with a bad checksum, and amounts that are not a decimal integer string, fail', async () => {
  const by = (r, id) => r.checks.find((c) => c.id === id);
  const typo = `${PAY_TO.slice(0, 20)}${PAY_TO[20] === 'a' ? 'b' : 'a'}${PAY_TO.slice(21)}`;
  const r = await diagnose(await seller(nano({ payTo: typo })), { safeFetch });
  assert.equal(by(r, 'accepts[0]-payto').status, 'fail');
  assert.match(by(r, 'accepts[0]-payto').message, /checksum/);
  for (const [amount, why] of [[1e27, /JSON number/], ['1e27', /no exponent or decimal point/], ['1000.5', /no exponent or decimal point/], ['0', /positive integer/], ['-5', /positive integer/]]) {
    const x = await diagnose(await seller(nano({ amount })), { safeFetch });
    assert.equal(by(x, 'accepts[0]-amount').status, 'fail', String(amount));
    assert.match(by(x, 'accepts[0]-amount').message, why, String(amount));
  }
});
