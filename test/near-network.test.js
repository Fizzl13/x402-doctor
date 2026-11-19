// NEAR (near:mainnet, @x402/near "exact"): Doctor knows the network and Circle's USDC on it, checks the payTo is a
// NEAR account id and the amount an integer in USDC's 6 decimals. Before 19 Nov 2026 a NEAR option was "CAIP-2 but not
// a network the doctor knows; asset checks are skipped" (presign-guard's own 402 has one since that day).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { preflight } = require('../lib/preflight');
const { diagnose } = require('../lib/diagnose');
const { createSafeFetch } = require('../lib/safe-fetch');
const { NETWORKS, V1_NAMES, isNearAccount, isNearImplicit, familyOf, dollarToken } = require('../lib/networks');

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
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
const near = (over = {}) => ({ network: 'near:mainnet', asset: USDC, amount: '10000', payTo: 'x402fizzl.near', ...over });
const checksOf = async (accept) => Object.fromEntries((await diagnose(await seller(accept), { safeFetch })).checks.filter((c) => c.id.startsWith('accepts[0]')).map((c) => [c.id, c]));

test('NEAR accounts, the near family, USDC and the v1 names', () => {
  for (const a of ['x402fizzl.near', 'pay.shop.near', 'a1', USDC, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd']) assert.equal(isNearAccount(a), true, a);
  for (const a of ['Shop.near', 'a', 'x..near', '.near', 'shop.near.', '0x6B0F4651eD42893ab58139938175E4a69f175F25', '', null]) assert.equal(isNearAccount(a), false, String(a));
  assert.equal(isNearImplicit(USDC), true);
  assert.equal(isNearImplicit('x402fizzl.near'), false);
  assert.equal(familyOf('near:mainnet'), 'near');
  assert.equal(NETWORKS['near:mainnet'].testnet, false);
  assert.equal(NETWORKS['near:testnet'].testnet, true);
  assert.deepEqual(dollarToken('near:mainnet', USDC), { symbol: 'USDC', decimals: 6 });
  assert.equal(V1_NAMES.near, 'near:mainnet');
});

test('diagnose: USDC on NEAR to a NEAR account passes network, payTo, asset and amount', async () => {
  const c = await checksOf(near());
  assert.equal(c['accepts[0]-network'].status, 'pass', c['accepts[0]-network'].message);
  assert.match(c['accepts[0]-network'].message, /NEAR \(near:mainnet\)/);
  assert.equal(c['accepts[0]-payto'].status, 'pass');
  assert.equal(c['accepts[0]-asset'].status, 'pass');
  assert.equal(c['accepts[0]-amount'].status, 'pass');
  assert.match(c['accepts[0]-amount'].message, /\$0\.01 in USDC/);
});

test('diagnose: a bad payTo, a capitalised one, usdc.near, a non-integer amount', async () => {
  assert.equal((await checksOf(near({ payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25' })))['accepts[0]-payto'].status, 'fail');
  const caps = (await checksOf(near({ payTo: 'Shop.near' })))['accepts[0]-payto'];
  assert.equal(caps.status, 'fail');
  assert.match(caps.message, /lowercase/);
  const wrong = (await checksOf(near({ asset: 'usdc.near' })))['accepts[0]-asset'];
  assert.equal(wrong.status, 'warn');
  assert.match(wrong.hint, new RegExp(USDC));
  assert.equal((await checksOf(near({ asset: 'wrap.near' })))['accepts[0]-asset'].status, 'info');
  assert.equal((await checksOf(near({ amount: '0.01' })))['accepts[0]-amount'].status, 'fail');
});

test('preflight: a NEAR-only seller is priced in USDC, not an unknown network or asset', async () => {
  const r = await preflight(await seller(near()), { safeFetch });
  const codes = r.reasons.map((x) => x.code);
  for (const bad of ['unknown_network', 'unknown_asset', 'testnet_only']) assert.ok(!codes.includes(bad), JSON.stringify(r.reasons));
});

// near-payout-registered (checkNear): read-only view calls against a stand-in RPC.
const { checkNear } = require('../lib/diagnose');
const { buildFixes } = require('../lib/recipes');
function nearRpc({ exists = true, registered = true, down = false } = {}) {
  const calls = [];
  const fetchImpl = async (_url, { body }) => {
    const { params } = JSON.parse(body);
    calls.push(params.request_type);
    if (down) throw new Error('offline');
    if (params.request_type === 'view_account') {
      return { ok: true, json: async () => (exists ? { result: { amount: '1' } } : { error: { cause: { name: 'UNKNOWN_ACCOUNT' }, message: 'Server error' } }) };
    }
    return { ok: true, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify(registered ? { total: '1250000000000000000000', available: '0' } : null))] } }) };
  };
  return { calls, fetchImpl };
}
const run = async (accept, rpc) => { const checks = []; await checkNear([accept], checks, { fetchImpl: rpc.fetchImpl, cache: false }); return checks.find((c) => c.id === 'near-payout-registered'); };

test('near-payout-registered: registered passes, unregistered and missing accounts fail with a fix, RPC down is info', async () => {
  assert.equal((await run(near(), nearRpc())).status, 'pass');
  const unreg = await run(near(), nearRpc({ registered: false }));
  assert.equal(unreg.status, 'fail');
  assert.match(unreg.message, /not registered on USDC/);
  const missing = await run(near(), nearRpc({ exists: false }));
  assert.equal(missing.status, 'fail');
  assert.match(missing.message, /does not exist/);
  assert.equal((await run(near(), nearRpc({ down: true }))).status, 'info');
  const fixes = buildFixes({ url: 'https://x.test/p', challenge: { accepts: [near()] }, checks: [unreg] });
  const fix = fixes.fixes.find((f) => f.recipe === 'near-registered');
  assert.ok(fix, JSON.stringify(fixes).slice(0, 300));
  assert.match(JSON.stringify(fix.code), /storage_deposit/);
});

test('near-payout-registered: an implicit payTo skips the account lookup; other networks are not asked', async () => {
  const rpc = nearRpc();
  assert.equal((await run(near({ payTo: USDC.replace(/^1/, '2') }), rpc)).status, 'pass');
  assert.deepEqual(rpc.calls, ['call_function']);
  const none = nearRpc();
  const checks = [];
  await checkNear([{ network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', amount: '10000' }], checks, { fetchImpl: none.fetchImpl, cache: false });
  assert.equal(none.calls.length, 0);
});
