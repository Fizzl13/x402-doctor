// Circle Gateway (nanopayments): "exact" options signed for the Gateway Wallet ("GatewayWalletBatched"), paid from
// a Gateway balance with Circle's client. Plus the Arc and Sonic networks they are offered on.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { checkAccepts, checkCoinbaseAgents } = require('../lib/diagnose');
const { NETWORKS, GATEWAY, isGatewayOption, dollarToken } = require('../lib/networks');
const { walletCompatibility, summaryCheck } = require('../lib/wallets');
const { createSafeFetch } = require('../lib/safe-fetch');
const { preflight } = require('../lib/preflight');

const BASE = 'eip155:8453';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const standard = (extra = {}) => ({ scheme: 'exact', network: BASE, asset: USDC_BASE, amount: '1000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }, ...extra });
// As Circle's middleware writes it (seen on x402.alchemy.com and nano.blockrun.ai, Oct 2026).
const gateway = (extra = {}, over = {}) => ({ scheme: 'exact', network: BASE, asset: USDC_BASE, amount: '1000', payTo: PAY_TO, maxTimeoutSeconds: 604900, extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee', ...extra }, ...over });
const ids = (checks, status) => checks.filter((c) => c.status === status).map((c) => c.id);

test('networks: Arc, Arc Testnet and Sonic with their USDC; a Gateway option is recognised by its domain name', () => {
  assert.equal(NETWORKS['eip155:5042'].name, 'Arc');
  assert.equal(NETWORKS['eip155:5042002'].testnet, true);
  assert.equal(NETWORKS['eip155:146'].name, 'Sonic');
  assert.deepEqual(dollarToken('eip155:5042', '0x3600000000000000000000000000000000000000'), { symbol: 'USDC', decimals: 6 });
  assert.equal(isGatewayOption(gateway()), true);
  assert.equal(isGatewayOption(standard()), false);
  assert.equal(isGatewayOption(gateway({}, { scheme: 'upto' })), false);
});

test('checkAccepts: a Gateway option passes without the 1..3600 timeout warning, and says who can pay it', () => {
  const checks = [];
  checkAccepts([gateway()], checks);
  assert.deepEqual(ids(checks, 'warn'), []);
  assert.deepEqual(ids(checks, 'fail'), []);
  assert.match(checks.find((c) => c.id === 'accepts[0]-extra').message, /Circle Gateway, signed for the Gateway Wallet/);
  const info = checks.find((c) => c.id === 'circle-gateway');
  assert.match(info.message, /^Every option is Circle Gateway \(nanopayments\), on Base:.*@circle-fin\/x402-batching.*Standard x402 clients/);
  assert.match(info.hint, /standard "exact" option too, listed first/);

  // Circle's client stretches the validity to 7 days itself, so a short timeout is no problem either.
  const short = [];
  checkAccepts([gateway({}, { maxTimeoutSeconds: 600 })], short);
  assert.equal(short.some((c) => c.id === 'accepts[0]-timeout'), false);
  // A standard option keeps the warning.
  const std = [];
  checkAccepts([standard({ maxTimeoutSeconds: 604900 })], std);
  assert.ok(ids(std, 'warn').includes('accepts[0]-timeout'));
});

test('checkAccepts: wrong version, missing or foreign verifyingContract; the testnet Gateway Wallet on testnets', () => {
  const version = [];
  checkAccepts([gateway({ version: '2' })], version);
  assert.match(version.find((c) => c.id === 'accepts[0]-extra' && c.status === 'fail').message, /only pays "GatewayWalletBatched" version "1"/);
  const missing = [];
  checkAccepts([gateway({ verifyingContract: undefined })], missing);
  const fail = missing.find((c) => c.id === 'accepts[0]-extra' && c.status === 'fail');
  assert.match(fail.message, /without a valid extra\.verifyingContract/);
  assert.match(fail.hint, new RegExp(GATEWAY.wallet));
  const foreign = [];
  checkAccepts([gateway({ verifyingContract: PAY_TO })], foreign);
  assert.match(foreign.find((c) => c.id === 'accepts[0]-extra' && c.status === 'warn').message, /is not Circle's Gateway Wallet on Base/);
  const testnet = [];
  checkAccepts([gateway({ verifyingContract: GATEWAY.testnetWallet }, { network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })], testnet);
  assert.equal(testnet.find((c) => c.id === 'accepts[0]-extra').status, 'pass');
});

test('checkAccepts: a Gateway option listed before the standard one on the same network makes x402 clients sign for Gateway', () => {
  const before = [];
  checkAccepts([gateway(), standard()], before);
  const order = before.find((c) => c.id === 'accepts-order');
  assert.equal(order.status, 'warn');
  assert.match(order.message, /accepts\[0\] \(Circle Gateway\) comes before accepts\[1\] \(standard "exact"\) on Base/);
  assert.match(before.find((c) => c.id === 'circle-gateway').message, /^1 of 2 options is Circle Gateway/);
  const after = [];
  checkAccepts([standard(), gateway()], after);
  assert.equal(after.some((c) => c.id === 'accepts-order'), false);
  // Another network's standard option doesn't count.
  const other = [];
  checkAccepts([gateway(), standard({ network: 'eip155:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' })], other);
  assert.equal(other.some((c) => c.id === 'accepts-order'), false);
});

test('wallets: only Circle Gateway agents pay a Gateway option; the standard option stays for everyone else', () => {
  const only = [gateway(), gateway({}, { network: 'eip155:5042', asset: '0x3600000000000000000000000000000000000000' })];
  const checks = [];
  checkAccepts(only, checks);
  const wallets = walletCompatibility(only, checks);
  assert.deepEqual(wallets.map((w) => w.wallet), ['Circle Gateway agents']);
  assert.deepEqual(wallets[0].yes, ['Base', 'Arc']);
  assert.match(summaryCheck(only, wallets).hint, /Only Circle Gateway clients can pay/);

  const mixed = [standard(), gateway()];
  const mixedChecks = [];
  checkAccepts(mixed, mixedChecks);
  const both = walletCompatibility(mixed, mixedChecks);
  assert.deepEqual(both.find((w) => w.wallet === 'x402 agents').yes, ['Base']);
  assert.deepEqual(both.find((w) => w.wallet === 'Circle Gateway agents').yes, ['Base']);
  assert.equal(summaryCheck(mixed, both).hint?.includes('Circle Gateway'), false);
});

test("checkCoinbaseAgents: USDC on Base only through Gateway is not payable by Coinbase's agent wallets", () => {
  const checks = [];
  checkCoinbaseAgents({ x402Version: 2, accepts: [gateway()] }, checks);
  const c = checks.find((x) => x.id === 'coinbase-agents');
  assert.equal(c.status, 'info');
  assert.match(c.message, /only through Circle Gateway/);
  const ok = [];
  checkCoinbaseAgents({ x402Version: 2, accepts: [gateway(), standard()] }, ok);
  assert.equal(ok.find((x) => x.id === 'coinbase-agents').status, 'pass');
});

// Preflight against a local seller.
const servers = [];
test.after(() => servers.forEach((s) => s.close()));
function seller(accepts) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
      const origin = `http://127.0.0.1:${server.address().port}`;
      const challenge = { x402Version: 2, resource: { url: `${origin}/paid`, mimeType: 'application/json', description: 'x' }, accepts };
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      res.end(JSON.stringify(challenge));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/paid`));
    servers.push(server);
  });
}
const safeFetch = createSafeFetch({ allowPrivate: true });

test('preflight: a cheaper Gateway option is not recommended over a standard one; Gateway only is a go with a note', async () => {
  const mixed = await preflight(await seller([gateway({}, { amount: '500' }), standard()]), { safeFetch });
  assert.equal(mixed.verdict, 'go');
  assert.equal(mixed.recommended_option, 1);
  assert.equal(mixed.reasons.some((r) => r.code === 'gateway_only'), false);

  const only = await preflight(await seller([gateway()]), { safeFetch });
  assert.equal(only.verdict, 'go');
  assert.equal(only.recommended_option, 0);
  assert.match(only.reasons.find((r) => r.code === 'gateway_only').message, /Circle's Gateway client/);
});

test("Trust Index: Circle's Agent Marketplace catalog, paged by 200, one entry per origin + path", async () => {
  const { loadCircleCatalog } = require('../lib/trust-scan');
  const item = (resource, method = 'GET', more = {}) => ({ resource, type: 'http', x402Version: 2, accepts: [gateway()], metadata: { method, description: `about ${resource}`, provider: { name: 'P' }, ...more } });
  const first = Array.from({ length: 200 }, (_, i) => item(`https://a.example/r${i}`, i % 2 ? 'POST' : 'DELETE'));
  const second = [
    item('https://a.example/r0?x=1'), // same origin + path as r0
    item('http://b.example/plain'), // not https
    item('https://c.example/items/{id}'), // a template without an example value
    item('https://c.example/users/{id}', 'GET', { input: { pathParams: { id: '42' } } }),
  ];
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.match(init.headers['user-agent'], /x402-doctor-trust-scan/);
    const offset = Number(new URL(url).searchParams.get('offset'));
    if (urls.length === 2) return new Response('{}', { status: 429 }); // rate limited once: tried again
    return new Response(JSON.stringify({ x402Version: 2, items: offset === 0 ? first : second, pagination: { limit: 200, offset, total: 204 } }), { status: 200 });
  };
  const pauses = [];
  const entries = await loadCircleCatalog({ fetchImpl, sleep: async (ms) => pauses.push(ms) });
  assert.deepEqual(pauses, [1000, 2000]);
  assert.equal(urls.length, 3);
  assert.match(urls[0], /^https:\/\/api\.circle\.com\/v2\/x402\/discovery\/resources\?type=http&limit=200&offset=0$/);
  assert.equal(entries.length, 202);
  assert.equal(entries[0].method, undefined, 'DELETE is not probed as such');
  assert.equal(entries[1].method, 'POST');
  assert.equal(entries[1].description, 'about https://a.example/r1');
  assert.deepEqual(entries.find((e) => e.url.endsWith('{id}') && e.url.includes('/items/')).template, true);
  assert.equal(entries.find((e) => e.url.includes('/users/')).probe, 'https://c.example/users/42');
  await assert.rejects(loadCircleCatalog({ fetchImpl: async () => new Response('{}', { status: 503 }), retryDelays: [] }), /Circle discovery HTTP 503/);
});
