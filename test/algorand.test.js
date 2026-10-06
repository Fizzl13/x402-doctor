// Algorand (x402 "exact" on the AVM): network, address with checksum, ASA asset, atomic amounts, the payout
// opt-in, and the preflight pricing and verdicts.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSafeFetch } = require('../lib/safe-fetch');
const { checkAccepts, checkAlgorand } = require('../lib/diagnose');
const { preflight } = require('../lib/preflight');
const { isAlgorandAddress, familyOf } = require('../lib/networks');
const { walletCompatibility } = require('../lib/wallets');

const ALGO = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const ALGO_TEST = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
const PAY_TO = 'SGLTUPAC7TKGKNNXKNPQ2QZCC7NJSLAKYZ7O7NOGGAPXWBFZTOLTPMSPPI'; // a real payout address from the GoPlausible listing
const option = (extra = {}) => ({ scheme: 'exact', network: ALGO, asset: '31566704', amount: '100000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { decimals: 6 }, ...extra });
const algod = (status) => async (url) => { algod.last = url; return new Response('{}', { status }); };

test('addresses: checksum verified, family from the network id', () => {
  assert.equal(isAlgorandAddress(PAY_TO), true);
  assert.equal(isAlgorandAddress(PAY_TO.slice(0, 57) + (PAY_TO.endsWith('A') ? 'B' : 'A')), false, 'a changed character breaks the checksum');
  assert.equal(isAlgorandAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), false);
  assert.equal(familyOf(ALGO), 'algorand');
  assert.equal(familyOf('algorand:somethingelse'), 'algorand');
});

test('checkAccepts: a valid USDC option passes; bad payTo, asset, amount and fee payer are caught', () => {
  const ok = [];
  checkAccepts([option()], ok);
  assert.deepEqual(ok.filter((c) => c.status !== 'pass').map((c) => c.id), []);
  assert.match(ok.find((c) => c.id === 'accepts[0]-amount').message, /\$0\.1 USDC/);
  const bad = [];
  checkAccepts([option({ payTo: '0xabc', asset: 'USDC', amount: '0.1', extra: { feePayer: 'nope' } }), option({ network: ALGO_TEST })], bad);
  const by = Object.fromEntries(bad.map((c) => [c.id, c.status]));
  assert.equal(by['accepts[0]-payto'], 'fail');
  assert.equal(by['accepts[0]-asset'], 'warn');
  assert.equal(by['accepts[0]-amount'], 'fail');
  assert.equal(by['accepts[0]-feepayer'], 'fail');
  assert.equal(by['accepts[1]-asset'], 'fail', 'mainnet USDC on the testnet is a mismatch');
});

test('checkAlgorand: opted in passes, not opted in fails, algod trouble is info', async () => {
  const pass = [];
  await checkAlgorand([option()], pass, { fetchImpl: algod(200) });
  assert.equal(pass[0].status, 'pass');
  assert.equal(algod.last, `https://mainnet-api.algonode.cloud/v2/accounts/${PAY_TO}/assets/31566704`);
  const fail = [];
  await checkAlgorand([option()], fail, { fetchImpl: algod(404) });
  assert.equal(fail[0].status, 'fail');
  assert.equal(fail[0].option, 0);
  const info = [];
  await checkAlgorand([option()], info, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(info[0].status, 'info');
});

test('wallets: Pera, Defly and x402 agents pay Algorand; nobody when the payout has not opted in', () => {
  const w = walletCompatibility([option()], []);
  assert.deepEqual(w.map((x) => x.wallet).sort(), ['Defly', 'Pera', 'x402 agents']);
  const blocked = walletCompatibility([option()], [{ id: 'algorand-payout-optin', status: 'fail', option: 0 }]);
  assert.ok(blocked.every((x) => x.yes.length === 0));
});

test('preflight: an Algorand USDC seller is go with its dollar price; no_go when the payout has not opted in', async () => {
  let origin;
  const server = http.createServer((req, res) => {
    const challenge = { x402Version: 2, resource: { url: `${origin}${req.url}`, description: 'ALGO market signal', mimeType: 'application/json' }, accepts: [option()] };
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json');
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  const safeFetch = createSafeFetch({ allowPrivate: true });
  try {
    const go = await preflight(`${origin}/signal`, { safeFetch, algodFetch: algod(200) });
    assert.equal(go.options[0].usd, 0.1);
    assert.equal(go.options[0].asset_symbol, 'USDC');
    assert.equal(go.options[0].network_name, 'Algorand');
    assert.equal(go.options[0].payable, true);
    assert.notEqual(go.verdict, 'no_go', JSON.stringify(go.reasons));
    const nogo = await preflight(`${origin}/signal`, { safeFetch, algodFetch: algod(404) });
    assert.equal(nogo.verdict, 'no_go');
    assert.equal(nogo.options[0].payable, false);
    assert.match(nogo.options[0].problems.join(' '), /opted in/);
  } finally {
    server.close();
  }
});
