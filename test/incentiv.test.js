// x402 on Incentiv (eip155:24101): Doctor knows the network, its USDC (no EIP-3009) and the two schemes of its own,
// and checks an option by the facilitator's rules (IncentivNetwork/incentiv-x402-public docs/SPEC.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { diagnose } = require('../lib/diagnose');
const { createSafeFetch } = require('../lib/safe-fetch');
const { NETWORKS, dollarToken } = require('../lib/networks');
const { FACILITATORS } = require('../lib/facilitators');

const USDC = '0x16e43840d8D79896A389a3De85aB0B0210C05685';
const EP = '0x3eC61c5633BBD7Afa9144C6610930489736a72d4';
const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const opt = (scheme, over = {}) => ({ scheme, network: 'eip155:24101', amount: '10000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: scheme === 'incentiv-userop' ? { entryPoint: EP } : {}, ...over });

async function diagnoseOf(accepts) {
  const server = http.createServer((req, res) => {
    const body = { x402Version: 2, error: 'Payment required', resource: { url: `http://127.0.0.1:${server.address().port}/weather` }, accepts };
    res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(body)).toString('base64') });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await diagnose(`http://127.0.0.1:${server.address().port}/weather`, { safeFetch: createSafeFetch({ allowPrivate: true }), siteScan: false });
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const of = (report, prefix) => report.checks.filter((c) => c.id.startsWith(prefix)).map((c) => `${c.status}:${c.id}`);

test('the network, its USDC without EIP-3009, and the facilitator on the board', () => {
  assert.equal(NETWORKS['eip155:24101'].name, 'Incentiv');
  const usdc = dollarToken('eip155:24101', USDC);
  assert.equal(usdc.symbol, 'USDC');
  assert.equal(usdc.decimals, 6);
  assert.equal(usdc.eip3009, false);
  assert.ok(FACILITATORS.some((f) => f.url === 'https://x402.incentiv.io'));
});

test('both schemes by the facilitator\'s rules: no unknown-scheme or unknown-network warning', async () => {
  const r = await diagnoseOf([opt('incentiv-eoa-tx'), opt('incentiv-userop')]);
  const a0 = of(r, 'accepts[0]'), a1 = of(r, 'accepts[1]');
  assert.deepEqual(a0, ['info:accepts[0]-scheme', 'pass:accepts[0]-payto', 'pass:accepts[0]-asset', 'pass:accepts[0]-amount']);
  assert.deepEqual(a1, ['info:accepts[1]-scheme', 'pass:accepts[1]-payto', 'pass:accepts[1]-asset', 'pass:accepts[1]-amount', 'pass:accepts[1]-entrypoint']);
  assert.match(r.checks.find((c) => c.id === 'accepts[1]-scheme').message, /@incentiv\/x402/);
});

test('what the facilitator would refuse is a fail', async () => {
  const r = await diagnoseOf([
    opt('incentiv-eoa-tx', { asset: '0x1111111111111111111111111111111111111111' }),
    opt('incentiv-eoa-tx', { maxTimeoutSeconds: 600 }),
    opt('incentiv-userop', { extra: {} }),
    opt('incentiv-eoa-tx', { amount: '0.01' }),
  ]);
  assert.ok(of(r, 'accepts[0]').includes('fail:accepts[0]-asset'));
  assert.ok(of(r, 'accepts[1]').includes('fail:accepts[1]-timeout'));
  assert.ok(of(r, 'accepts[2]').includes('fail:accepts[2]-entrypoint'));
  assert.ok(of(r, 'accepts[3]').includes('fail:accepts[3]-amount'));
});

test('an "exact" option on Incentiv: its USDC has no EIP-3009, so it cannot settle', async () => {
  const r = await diagnoseOf([{ scheme: 'exact', network: 'eip155:24101', amount: '10000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } }]);
  assert.ok(of(r, 'accepts[0]').includes('fail:accepts[0]-extra'), JSON.stringify(of(r, 'accepts[0]')));
});
