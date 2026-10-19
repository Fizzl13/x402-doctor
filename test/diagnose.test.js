// Integration tests: the doctor against local fixture servers. "healthy" is
// shaped like a correct @x402/express v2 service (Base + Solana, Bazaar,
// OpenAPI, mainnet paywall); "broken" reproduces real bugs we hit.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { diagnose, checkResource, checkAccepts, checkOpenApi, checkWellKnown, checkBazaarListing, checkPaywall, checkMerchant, checkBuilderCode } = require('../lib/diagnose');
const { createBazaarIndex } = require('../lib/bazaar-index');
const { createSafeFetch, guardedLookup } = require('../lib/safe-fetch');
const { createApp } = require('../server');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYOUT_WITH_ATA = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';
const PAYOUT_WITHOUT_ATA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const PAYAI_FEE_PAYER = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';

const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
};

// declareDiscoveryExtension returns { bazaar: { info, schema } }; the resource
// server adds routeTemplate when it builds the challenge.
const declared = declareDiscoveryExtension({
  method: 'GET',
  pathParams: { pair: 'BTC-USDT' },
  pathParamsSchema: { properties: { pair: { type: 'string' } }, required: ['pair'] },
  input: { interval: '1h' },
  inputSchema: { properties: { interval: { type: 'string', enum: ['1h', '4h'] } } },
  output: {
    schema: { type: 'object', required: ['signal'], properties: { signal: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] } } },
    example: { signal: 'bullish' },
  },
});
const bazaar = { ...declared.bazaar, routeTemplate: '/signal/:pair' };

function healthyChallenge(origin, path) {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: `${origin}${path}`, description: 'Ichimoku signal', mimeType: 'application/json', serviceName: 'Ichimoku Signal', tags: ['trading'] },
    accepts: [
      { scheme: 'exact', network: BASE, amount: '20000', asset: USDC_BASE, payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
      { scheme: 'exact', network: SOLANA, amount: '20000', asset: USDC_SOLANA, payTo: PAYOUT_WITH_ATA, maxTimeoutSeconds: 300, extra: { feePayer: PAYAI_FEE_PAYER } },
    ],
    extensions: { bazaar },
  };
}

function brokenChallenge() {
  return {
    // no x402Version, v1 network name, testnet USDC on mainnet, decimal amount,
    // Solana without feePayer and a payout wallet without a USDC account
    resource: { url: 'http://example.com/elsewhere' },
    accepts: [
      { scheme: 'exact', network: 'base', amount: '20000', asset: USDC_BASE, payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
      { scheme: 'exact', network: BASE, amount: '0.02', asset: USDC_BASE_SEPOLIA, payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 300 },
      { scheme: 'exact', network: SOLANA, amount: '20000', asset: USDC_SOLANA, payTo: PAYOUT_WITHOUT_ATA, maxTimeoutSeconds: 300 },
    ],
  };
}

let healthyUrl;
let brokenUrl;
let rpcUrl;

test.before(async () => {
  healthyUrl = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/openapi.json') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ openapi: '3.0.3', info: { title: 'Ichimoku', 'x-guidance': 'Use for a quick Ichimoku read.' } }));
    }
    if (url.pathname.startsWith('/signal/')) {
      const challenge = healthyChallenge(healthyUrl, url.pathname);
      res.statusCode = 402;
      res.setHeader('PAYMENT-REQUIRED', b64(challenge));
      if ((req.headers.accept || '').includes('text/html')) {
        res.setHeader('content-type', 'text/html');
        return res.end('<html><head><script>window.x402 = { amount: 0.02, testnet: false };</script></head></html>');
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ x402Version: 2, accepts: challenge.accepts }));
    }
    res.statusCode = 404;
    res.end();
  });

  brokenUrl = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/signal/BTC-USDT' && url.searchParams.get('interval') === '1h' && url.searchParams.get('bad')) {
      res.statusCode = 400;
      return res.end('{}');
    }
    if (url.pathname.startsWith('/signal/')) {
      res.statusCode = 402;
      // header-only (no body mirror), declared example that answers 400
      const challenge = { ...brokenChallenge(), extensions: { bazaar: { ...bazaar, info: { ...bazaar.info, input: { ...bazaar.info.input, queryParams: { interval: '1h', bad: '1' } } } } } };
      res.setHeader('PAYMENT-REQUIRED', b64(challenge));
      if ((req.headers.accept || '').includes('text/html')) {
        res.setHeader('content-type', 'text/html');
        return res.end('<html><script>window.x402 = { testnet: true };</script></html>');
      }
      return res.end('{}');
    }
    res.statusCode = 404;
    res.end();
  });

  rpcUrl = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'application/json');
    // Base: the healthy fixture's payout wallet is a regular wallet (no code).
    if (body.method === 'eth_getCode') return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' }));
    if (body.method === 'getTokenAccountsByOwner') {
      const value = body.params[0] === PAYOUT_WITH_ATA ? [{ pubkey: 'HDp3B6rtQV5X9FmMgCLabGkkk4LfzmlncraeLFoQEV4a', account: {} }] : [];
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value } }));
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unsupported' } }));
  });

  const payai = await listen((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: PAYAI_FEE_PAYER } }], extensions: [], signers: {} }));
  });
  process.env.PAYAI_SUPPORTED_URL = `${payai}/supported`;
  process.env.BASE_RPC_URL = rpcUrl; // also reaches the CLI test through its env
});

test.after(() => servers.forEach((s) => s.close()));

const safeFetch = createSafeFetch({ allowPrivate: true });
const byId = (report) => {
  const map = {};
  for (const c of report.checks) (map[c.id] ||= []).push(c);
  return map;
};
const statusOf = (report, id) => (byId(report)[id] || []).map((c) => c.status);

test('healthy v2 service: no failures, every group covered', async () => {
  const report = await diagnose(`${healthyUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl });
  const failures = report.checks.filter((c) => c.status === 'fail');
  assert.deepEqual(failures, []);
  for (const id of ['returns-402', 'protocol-version', 'envelope-body-mirror', 'resource-url', 'resource-metadata', 'bazaar', 'bazaar-output', 'bazaar-replay', 'solana-payout-account', 'openapi-present', 'paywall']) {
    assert.deepEqual(statusOf(report, id), ['pass'], id);
  }
  assert.deepEqual(statusOf(report, 'accepts[0]-extra'), ['pass']);
  assert.deepEqual(statusOf(report, 'accepts[1]-extra'), ['pass']);
  assert.match(byId(report)['accepts[1]-amount'][0].message, /\$0\.02 USDC/);
  // PayAI settles Solana here, so Phantom users are warned about
  assert.deepEqual(statusOf(report, 'solana-wallets'), ['warn']);
  assert.equal(report.overall, 'warn');
  assert.deepEqual([...new Set(report.checks.map((c) => c.group))], ['challenge', 'accepts', 'resource', 'settlement', 'wallets', 'discovery', 'browser']);

  // Who can pay: EVM wallets on Base, Phantom on Base but not on Solana (PayAI)
  const wallet = (name) => report.wallets.find((w) => w.wallet === name);
  assert.deepEqual(wallet('MetaMask'), { wallet: 'MetaMask', agent: false, yes: ['Base'], no: [], notes: ['Base: may show a Blockaid "deceptive request" warning (payout wallet is an EOA)'] });
  assert.equal(wallet('Rabby').notes, undefined);
  // The payout wallet is a regular wallet: MetaMask's Blockaid check may warn
  const eoa = byId(report)['evm-payto-eoa'];
  assert.equal(eoa.length, 1);
  assert.equal(eoa[0].status, 'info');
  assert.equal(eoa[0].group, 'wallets');
  assert.match(eoa[0].message, /regular wallet \(EOA\).*deceptive request/);
  assert.match(eoa[0].hint, /Report an issue/);
  assert.deepEqual(wallet('Phantom').yes, ['Base']);
  assert.deepEqual(wallet('Phantom').no, [{ network: 'Solana', reason: 'PayAI rejects Phantom transactions' }]);
  assert.deepEqual(wallet('Solflare').yes, ['Solana']);
  assert.deepEqual(wallet('x402 agents').yes, ['Base', 'Solana']);
  const summary = byId(report).wallets[0];
  assert.equal(summary.status, 'info');
  assert.match(summary.message, /^Who can pay: MetaMask ✓ Base \(may warn\) .*Phantom ✓ Base, ✗ Solana/);
  assert.equal(summary.hint, undefined);
});

test('broken service: nobody can pay, and the wallet summary says so', async () => {
  const report = await diagnose(`${brokenUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl });
  const agents = report.wallets.find((w) => w.wallet === 'x402 agents');
  assert.deepEqual(agents.yes, []);
  assert.ok(agents.no.some((n) => n.reason === 'the option has errors (see above)'));
  assert.match((byId(report).wallets || [])[0].message, /^Nobody can pay yet/);
});

test('broken service: each known mistake is reported with a hint', async () => {
  const report = await diagnose(`${brokenUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl });
  const find = (id) => byId(report)[id] || [];
  assert.equal(report.overall, 'fail');
  assert.equal(find('protocol-version')[0].status, 'fail', 'missing x402Version');
  assert.equal(find('envelope-body-mirror')[0].status, 'warn', 'header-only envelope');
  assert.equal(find('accepts[0]-network')[0].status, 'warn');
  assert.match(find('accepts[0]-network')[0].hint, /eip155:8453/);
  assert.equal(find('accepts[1]-amount')[0].status, 'warn', 'decimal amount');
  assert.equal(find('accepts[1]-asset')[0].status, 'fail', 'Base Sepolia USDC on Base');
  assert.match(find('accepts[1]-asset')[0].message, /Base Sepolia/);
  assert.equal(find('accepts[1]-extra')[0].status, 'fail', 'missing EIP-712 domain');
  assert.equal(find('accepts[2]-extra')[0].status, 'fail', 'missing Solana feePayer');
  assert.equal(find('solana-payout-account')[0].status, 'fail', 'payout wallet without USDC account');
  assert.match(find('solana-payout-account')[0].hint, /token account/);
  assert.equal(find('bazaar-replay')[0].status, 'warn', 'declared example answers 400');
  assert.equal(find('paywall')[0].status, 'fail', 'testnet paywall on mainnet');
  assert.equal(find('openapi-present')[0].status, 'warn');
  for (const c of report.checks.filter((c) => c.status === 'fail')) assert.ok(c.group, `${c.id} has a group`);
});

test('http resource URL behind an https endpoint is flagged with the trust proxy fix', () => {
  const checks = [];
  checkResource({ x402Version: 2, resource: { url: 'http://api.example.com/signal/BTC-USDT', description: 'x', mimeType: 'application/json' } }, 'https://api.example.com/signal/BTC-USDT', checks);
  const c = checks.find((x) => x.id === 'resource-url');
  assert.equal(c.status, 'fail');
  assert.match(c.hint, /trust proxy/);
});

test('resource URL: a path template on either side is the same route; another host or path still differs', () => {
  const status = (declared, requested) => {
    const checks = [];
    checkResource({ x402Version: 2, resource: { url: declared, description: 'x', mimeType: 'application/json' } }, requested, checks);
    return checks.find((x) => x.id === 'resource-url').status;
  };
  assert.equal(status('https://api.example.com/v1/company/{siren}/invoice', 'https://api.example.com/v1/company/:siren/invoice'), 'pass');
  assert.equal(status('https://api.example.com/v1/org/{address}', 'https://api.example.com/v1/org/PN76UT5PALEF'), 'pass');
  assert.equal(status('https://api.example.com/v1/edge/nyc-high-temp', 'https://api.example.com/v1/edge/:slug'), 'pass');
  assert.equal(status('https://api.example.com/v1/item/[id]', 'https://api.example.com/v1/item/42'), 'pass');
  assert.equal(status('https://api.example.com/paid/test', 'https://example.com/paid/test'), 'warn', 'another host');
  assert.equal(status('https://api.example.com/chapters/unlock', 'https://api.example.com/chapters/6a7e/unlock'), 'warn', 'a segment left out');
  assert.equal(status('https://api.example.com/x/should-pay/:address', 'https://api.example.com/x/solana/should-pay/:address'), 'warn', 'another path');
  assert.equal(status('https://api.example.com/v1/a', 'https://api.example.com/v1/b'), 'warn');
});

test('multi-chain options: XRPL and Arbitrum are judged by their own rules, unknown chains are not failed', () => {
  const checks = [];
  checkAccepts([
    // Shaped like a real XRPL option (RLUSD, decimal amount, r-address, issuer).
    { scheme: 'exact', network: 'xrpl:0', amount: '0.01', asset: '524C555344000000000000000000000000000000', payTo: 'rKv7LTd19CUsKKirVzdZWK4HuFChHf4Hp7', maxTimeoutSeconds: 300, extra: { issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' } },
    { scheme: 'exact', network: 'eip155:42161', amount: '10000', asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F', extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'aptos:1', amount: '0.01', asset: 'USDC', payTo: '0xabc' },
    { scheme: 'exact', network: 'xrpl:0', amount: '0', asset: 'USD', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F' },
  ], checks);
  const status = (id) => checks.find((c) => c.id === id)?.status;
  assert.equal(status('accepts[0]-network'), 'pass');
  assert.equal(status('accepts[0]-payto'), 'pass');
  assert.equal(status('accepts[0]-amount'), 'pass');
  assert.equal(status('accepts[0]-asset'), undefined);
  assert.equal(status('accepts[1]-network'), 'pass');
  assert.match(checks.find((c) => c.id === 'accepts[1]-amount').message, /\$0\.01 USDC/);
  assert.equal(status('accepts[2]-network'), 'warn');
  assert.equal(status('accepts[2]-payto'), 'info');
  assert.ok(!checks.some((c) => c.id.startsWith('accepts[2]') && c.status === 'fail'));
  assert.equal(status('accepts[3]-payto'), 'fail');
  assert.equal(status('accepts[3]-asset'), 'warn');
  assert.equal(status('accepts[3]-amount'), 'fail');
});

test('a description over the CDP limit of 500 characters is flagged (v2 resource and v1 accepts)', () => {
  const resource = (description) => ({ x402Version: 2, resource: { url: 'https://api.example.com/x', description, mimeType: 'application/json' } });
  const status = (checks, id) => checks.find((c) => c.id === id)?.status;
  let checks = [];
  checkResource(resource('a'.repeat(501)), 'https://api.example.com/x', checks);
  assert.equal(status(checks, 'resource-description-length'), 'warn');
  assert.match(checks.find((c) => c.id === 'resource-description-length').message, /501 characters/);
  checks = [];
  checkResource(resource('a'.repeat(480)), 'https://api.example.com/x', checks);
  assert.equal(status(checks, 'resource-description-length'), 'info');
  checks = [];
  checkResource(resource('é'.repeat(500)), 'https://api.example.com/x', checks);
  assert.equal(status(checks, 'resource-description-length'), 'info', 'characters, not bytes');
  checks = [];
  checkResource(resource('short'), 'https://api.example.com/x', checks);
  assert.equal(status(checks, 'resource-description-length'), undefined);
  checks = [];
  checkAccepts([{ scheme: 'exact', network: 'base', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F', description: 'b'.repeat(600) }], checks);
  assert.equal(status(checks, 'accepts[0]-description-length'), 'warn');
});

test('a payTo that is the zero address or another burn address fails: nobody gets paid there', () => {
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const checks = [];
  checkAccepts([
    { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: usdc, payTo: '0x0000000000000000000000000000000000000000' },
    { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: usdc, payTo: '0x000000000000000000000000000000000000dEaD' },
    { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: usdc, payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F' },
  ], checks);
  const payto = (i) => checks.find((c) => c.id === `accepts[${i}]-payto`);
  assert.equal(payto(0).status, 'fail');
  assert.match(payto(0).message, /the zero address: USDC refuses transfers to it/);
  assert.equal(payto(1).status, 'fail');
  assert.match(payto(1).message, /0x…dEaD burn address: what is paid there can never be spent/);
  assert.equal(payto(2).status, 'pass');
});

test('an openapi.json cut off at the size cap is reported as too large, not as invalid JSON', async () => {
  const checks = [];
  const fetchCapped = async () => ({ status: 200, text: '{"openapi":"3.1.0","paths":{"/a":', truncated: true });
  await checkOpenApi('https://api.example.com', fetchCapped, checks);
  const c = checks.find((x) => x.id === 'openapi-present');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /too large/);
  assert.doesNotMatch(c.message, /not valid JSON/);
});

test('x402scan readiness: contact e-mail, ownership proof against the payTo, input schemas and free routes', async () => {
  const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
  const payout = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const origin = 'https://api.example.com';
  const spec = (extra = {}) => ({
    openapi: '3.1.0',
    info: { title: 'T', 'x-guidance': 'g' },
    paths: {
      '/paid': { get: { 'x-payment-info': { price: { amount: '0.01' } }, parameters: [{ name: 'q', in: 'query' }] } },
      '/pack': { get: { 'x-payment-info': { price: { amount: '1' } } } },
      '/status': { get: {} },
      '/open': { get: { security: [] } },
    },
    ...extra,
  });
  const run = async (json, payTos = [payout.address]) => {
    const checks = [];
    await checkOpenApi(origin, async () => ({ status: 200, text: JSON.stringify(json) }), checks, { payTos });
    return Object.fromEntries(checks.map((c) => [c.id, c]));
  };

  let c = await run(spec());
  assert.equal(c['openapi-contact'].status, 'info');
  assert.equal(c['openapi-ownership'].status, 'info');
  assert.match(c['openapi-input-schema'].message, /GET \/pack/);
  assert.doesNotMatch(c['openapi-input-schema'].message, /GET \/paid/);
  assert.match(c['openapi-free-routes'].message, /GET \/status/);
  assert.doesNotMatch(c['openapi-free-routes'].message, /GET \/open/);

  const good = await payout.signMessage({ message: origin });
  c = await run(spec({ info: { title: 'T', 'x-guidance': 'g', contact: { email: 'a@b.c' } }, 'x-agentcash-provenance': { ownershipProofs: [good] } }));
  assert.equal(c['openapi-contact'], undefined);
  assert.equal(c['openapi-ownership'].status, 'pass');
  assert.match(c['openapi-ownership'].message, new RegExp(payout.address.toLowerCase()));

  c = await run(spec({ 'x-discovery': { ownershipProofs: [good] } }));
  assert.equal(c['openapi-ownership'].status, 'pass', 'the older x-discovery place is read too');

  c = await run(spec({ 'x-agentcash-provenance': { ownershipProofs: [await payout.signMessage({ message: `${origin}/` })] } }));
  assert.equal(c['openapi-ownership'].status, 'warn');
  assert.match(c['openapi-ownership'].message, /trailing slash/);

  c = await run(spec({ 'x-agentcash-provenance': { ownershipProofs: [await other.signMessage({ message: origin })] } }));
  assert.equal(c['openapi-ownership'].status, 'warn');
  assert.match(c['openapi-ownership'].message, /not a payTo/);

  c = await run(spec({ 'x-agentcash-provenance': { ownershipProofs: ['0x1234'] } }));
  assert.equal(c['openapi-ownership'].status, 'warn');
  assert.match(c['openapi-ownership'].message, /not a valid signature/);

  c = await run(spec({ ownershipProofs: [good] }));
  assert.equal(c['openapi-ownership'].status, 'warn');
  assert.match(c['openapi-ownership'].message, /top level/);

  c = await run(spec({ 'x-agentcash-provenance': { ownershipProofs: [good] } }), []);
  assert.equal(c['openapi-ownership'].status, 'info', 'no EVM payTo to check against');
});

test('POST-only endpoint: falls back to POST, or uses --method', async () => {
  const url = await listen((req, res) => {
    res.statusCode = req.method === 'POST' ? 402 : 405;
    if (req.method === 'POST') res.setHeader('PAYMENT-REQUIRED', b64({ x402Version: 2, accepts: [] }));
    res.end();
  });
  const auto = await diagnose(`${url}/paid`, { safeFetch, rpcUrl });
  assert.equal(auto.method, 'POST');
  const forced = await diagnose(`${url}/paid`, { safeFetch, rpcUrl, method: 'GET' });
  assert.deepEqual(statusOf(forced, 'returns-402'), ['fail']);
  assert.match(byId(forced)['returns-402'][0].message, /GET 405/);
});

test('no 402 behind Cloudflare: the hint names the usual Monetization Gateway rule misses', async () => {
  const url = await listen((req, res) => {
    res.setHeader('cf-ray', '8f1e2d3c4b5a6978-AMS');
    res.statusCode = 200;
    res.end('{"free":true}');
  });
  const report = await diagnose(`${url}/paid`, { safeFetch, rpcUrl });
  const check = byId(report)['returns-402'][0];
  assert.equal(check.status, 'fail');
  assert.match(check.hint, /Monetization Gateway/);
  assert.match(check.hint, /GET only by default/);
  assert.match(check.hint, /Verified Bots/);
  const plain = await listen((req, res) => { res.statusCode = 200; res.end('{}'); });
  assert.doesNotMatch(byId(await diagnose(`${plain}/paid`, { safeFetch, rpcUrl }))['returns-402'][0].hint, /Cloudflare/, 'only behind Cloudflare');
});

test('behind CloudFront: no 402 gets the AWS WAF Monetize hint; a 402 on testnets only notes the Test currency mode', async () => {
  const free = await listen((req, res) => {
    res.setHeader('x-amz-cf-id', 'Qm8YFq1xZz4w7l2Kx0aZ7mLwB3p9v1Yt6cQe4uHnRk2sD5fJgA==');
    res.setHeader('via', '1.1 2f3e4d5c6b7a.cloudfront.net (CloudFront)');
    res.statusCode = 200;
    res.end('{"free":true}');
  });
  const hint = byId(await diagnose(`${free}/paid`, { safeFetch, rpcUrl }))['returns-402'][0].hint;
  assert.match(hint, /AWS WAF Monetize/);
  assert.match(hint, /Bot Control's bot label charges only callers WAF labels as bots/);
  assert.doesNotMatch(hint, /Cloudflare/);

  const testMode = (network) => listen((req, res) => {
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}` }, accepts: [{ scheme: 'exact', network, amount: '1000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }] };
    res.setHeader('server', 'CloudFront');
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.statusCode = 402;
    res.end(JSON.stringify(challenge));
  });
  const sepolia = byId(await diagnose(`${await testMode('eip155:84532')}/paid`, { safeFetch, rpcUrl }))['aws-test-mode'];
  assert.equal(sepolia[0].status, 'info');
  assert.match(sepolia[0].message, /only testnets \(Base Sepolia\).*currency mode is Test/);
  assert.equal(byId(await diagnose(`${await testMode('eip155:8453')}/paid`, { safeFetch, rpcUrl }))['aws-test-mode'], undefined, 'nothing on mainnet');
});

test('x401: an endpoint that asks for proof of identity before the 402 is read as x401, not as broken', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = { scheme: 'x401', version: '0.2.0', credential_requirements: { digital: { requests: [{ protocol: 'openid4vp-v1-signed', data: { request: 'eyJ…' } }] } }, oauth: { token_endpoint: 'https://verifier.example/token' }, payment: { required: true, scheme_hint: 'x402' } };
  const verifier = (header, value) => listen((req, res) => { res.statusCode = 401; res.setHeader(header, value); res.end(); });
  const good = byId(await diagnose(`${await verifier('PROOF-REQUEST', b64(payload))}/paid`, { safeFetch, rpcUrl }));
  assert.equal(good['returns-402'][0].status, 'info');
  assert.match(good['returns-402'][0].message, /asks for proof of who is behind the agent first \(x401, GET 401\)/);
  assert.deepEqual(good.x401.map((c) => [c.status, c.message]), [['pass', 'Asks for proof before payment (x401 0.2.0: openid4vp-v1-signed, token exchange at verifier.example; payment afterwards via x402).']]);

  const legacy = byId(await diagnose(`${await verifier('PROOF-REQUIRED', b64(payload))}/paid`, { safeFetch, rpcUrl })).x401[0];
  assert.equal(legacy.status, 'info');
  assert.match(legacy.message, /PROOF-REQUIRED, the name in Proof's early material/);

  const bad = byId(await diagnose(`${await verifier('PROOF-REQUEST', b64({ scheme: 'x402', credential_requirements: { digital: { requests: [] } } }))}/paid`, { safeFetch, rpcUrl })).x401[0];
  assert.equal(bad.status, 'warn');
  assert.match(bad.message, /scheme is "x402", not "x401"; version is missing; credential_requirements\.digital\.requests is missing or empty/);
  assert.match(byId(await diagnose(`${await verifier('PROOF-REQUEST', 'not json at all')}/paid`, { safeFetch, rpcUrl })).x401[0].message, /not base64url-encoded JSON/);
});

test('SSRF guard: internal targets are refused, including through DNS', async () => {
  const guarded = createSafeFetch();
  for (const target of ['http://127.0.0.1/', 'http://localhost/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data', 'http://2130706433/', 'http://10.0.0.1/']) {
    await assert.rejects(guarded(target), (err) => err.code === 'EBLOCKED', target);
  }
  await assert.rejects(guarded('file:///etc/passwd'), /Only http\/https/);
  await new Promise((resolve) =>
    guardedLookup('localhost', {}, (err) => {
      assert.equal(err?.code, 'EBLOCKED');
      resolve();
    })
  );
});

test('response bodies are size-capped', async () => {
  const url = await listen((_req, res) => res.end('x'.repeat(50_000)));
  const small = createSafeFetch({ allowPrivate: true, maxBodyBytes: 1000 });
  const res = await small(url);
  assert.equal(res.text.length, 1000);
  assert.equal(res.truncated, true);
});

test('API: refuses internal URLs, validates input and rate-limits', async () => {
  const app = createApp({ rateLimit: { windowMs: 60_000, max: 3 } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const post = (body) => fetch(`${api}/api/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const internal = await post({ url: `${healthyUrl}/signal/BTC-USDT` });
  assert.equal(internal.status, 400);
  assert.match((await internal.json()).error, /local\/internal/);
  assert.equal((await post({ url: 'not a url' })).status, 400);
  assert.equal((await post({ url: 'https://example.com', method: 'DELETE' })).status, 400);
  const limited = await post({ url: 'http://127.0.0.1/' });
  assert.equal(limited.status, 429);
});

test('web diagnose refuses two URLs pasted into each other', async () => {
  const app = createApp({ rateLimit: { windowMs: 60_000, max: 10 } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const post = (url) => fetch(`${api}/api/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
  const glued = await post('https://smartcontractexplainhttps://pg1-ai-agent.vercel.app/api/mcper.onrender.com/api/check-wallet');
  assert.equal(glued.status, 400);
  assert.match((await glued.json()).error, /two URLs pasted into each other/);
  // A URL inside the query string is fine.
  const res = await post('http://127.0.0.1/pay?return=https://example.com/done');
  assert.doesNotMatch((await res.json()).error || '', /two URLs/);
});

test('free check answers the fizzl.eu demo (CORS), and only that origin', async () => {
  const app = createApp({ rateLimit: { windowMs: 60_000, max: 10 } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const pre = await fetch(`${api}/api/diagnose`, { method: 'OPTIONS', headers: { origin: 'https://fizzl.eu', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://fizzl.eu');
  const res = await fetch(`${api}/api/diagnose`, { method: 'POST', headers: { origin: 'https://fizzl.eu', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'not a url' }) });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://fizzl.eu');
  const other = await fetch(`${api}/api/diagnose`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'not a url' }) });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const paid = await fetch(`${api}/api/v1/diagnose?url=https://example.com`, { headers: { origin: 'https://fizzl.eu' } });
  assert.equal(paid.headers.get('access-control-allow-origin'), null);
});

test('web page: no pre-filled URL, the example is a link, reports name their URL', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(html, /id="urlInput"[^>]*\svalue=/);
  assert.match(html, /id="exampleLink" data-url="https:\/\/plaintext\.fizzl\.eu\/api\/check-wallet"/);
  assert.match(html, /if \(id !== runId\) return;/);
  assert.match(html, /failed · \$\{url\}/);
});

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'x402-doctor.js'), ...args], { env: { ...process.env, SOLANA_RPC_URL: rpcUrl } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    );
  });
}

test('CLI: exit codes for healthy, broken and --strict, JSON output, usage errors', async () => {
  const healthy = await runCli([`${healthyUrl}/signal/BTC-USDT`]);
  assert.equal(healthy.code, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /WARN: \d+ passed, 1 warnings, 0 failed/);
  assert.match(healthy.stdout, /→ To accept Phantom/);

  const strict = await runCli([`${healthyUrl}/signal/BTC-USDT`, '--strict']);
  assert.equal(strict.code, 1, 'warnings fail with --strict');

  const broken = await runCli([`${brokenUrl}/signal/BTC-USDT`, '--json']);
  assert.equal(broken.code, 1);
  assert.equal(JSON.parse(broken.stdout).overall, 'fail');

  const usage = await runCli([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /usage: x402-doctor <url>/);
});

test('payout wallet upgraded to a smart account (EIP-7702) still counts as an EOA', async () => {
  const { checkEvmPayTo } = require('../lib/diagnose');
  const codes = {
    '0x1111111111111111111111111111111111111111': '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b',
    '0x2222222222222222222222222222222222222222': '0x6080604052',
  };
  const rpc = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: codes[body.params[0]] || '0x' }));
  });
  const accepts = [
    { scheme: 'exact', network: BASE, payTo: '0x1111111111111111111111111111111111111111' },
    { scheme: 'exact', network: BASE, payTo: '0x2222222222222222222222222222222222222222' },
  ];
  const checks = [];
  await checkEvmPayTo(accepts, checks, { evmRpcUrls: { [BASE]: rpc } });
  assert.equal(checks.length, 1, 'the contract payout wallet gets no check');
  assert.equal(checks[0].option, 0);
  assert.match(checks[0].message, /EIP-7702/);
});

test('custom scheme (txHash): no feePayer fail, a softer payout-account warning, Optimism known, nobody counted as able to pay', async () => {
  const evmPayTo = '0xAd3dB8e2b1A311701E6233f17F6d648e4A52287c';
  const solPayTo = 'Hp4FLLbuHKtMNMmTLdkJ6J2Kgax8Wj2Sk92JAbu47EX2';
  const opt = (network, asset, payTo) => ({ scheme: 'txHash', network, asset, payTo, amount: '100000', maxTimeoutSeconds: 300 });
  const challenge = {
    x402Version: 2,
    accepts: [
      opt('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', evmPayTo),
      opt('eip155:10', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', evmPayTo),
      opt(SOLANA, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', solPayTo),
    ],
  };
  const url = await listen((req, res) => {
    res.statusCode = req.method === 'POST' ? 402 : 405;
    if (req.method === 'POST') res.setHeader('PAYMENT-REQUIRED', b64(challenge));
    res.end(JSON.stringify(challenge));
  });
  const report = await diagnose(`${url}/api/x402/cuni/check`, { safeFetch, rpcUrl });
  const checks = byId(report);
  assert.equal(checks['accepts[2]-extra'], undefined, 'no feePayer check for a custom scheme');
  assert.match(checks['accepts[0]-scheme'][0].message, /only clients built for this scheme can pay/);
  assert.match(checks['accepts[1]-network'][0].message, /Optimism/);
  const payout = checks['solana-payout-account'][0];
  assert.equal(payout.status, 'warn');
  assert.match(payout.message, /payer's wallet also creates that account/);
  const agents = report.wallets.find((w) => w.wallet === 'x402 agents');
  assert.deepEqual(agents.yes, []);
  assert.match(agents.no[0].reason, /custom scheme "txHash"/);
  assert.notEqual(report.overall, 'fail');
  const summary = checks.wallets[0];
  assert.match(summary.message, /^Only clients built for the "txHash" scheme can pay/);
  assert.doesNotMatch(summary.message, /Nobody can pay/);
  assert.match(summary.hint, /"exact" option/);
});

// ------------------------------------------------------------ domain move

const fakeFetch = (status, body) => async () => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body), headers: new Map() });
async function wellKnown(origin, status, body) {
  const checks = [];
  await checkWellKnown(origin, fakeFetch(status, body), checks);
  return checks.find((c) => c.id === 'well-known');
}

test('well-known: resources on this origin pass; on another host warn; missing is info', async () => {
  assert.equal((await wellKnown('https://api.example.com', 200, { version: 1, resources: ['https://api.example.com/a', 'https://api.example.com/b'] })).status, 'pass');
  const moved = await wellKnown('https://api.example.com', 200, { version: 1, resources: ['https://api.onrender.com/a'] });
  assert.equal(moved.status, 'warn');
  assert.match(moved.message, /https:\/\/api\.onrender\.com, not on https:\/\/api\.example\.com/);
  assert.match(moved.hint, /PUBLIC_URL/);
  assert.equal((await wellKnown('https://api.example.com', 404, '')).status, 'info');
  assert.equal((await wellKnown('https://api.example.com', 200, '<html>')).status, 'warn');
});

test('well-known: a platform address pointing at its own domain is info, not a warning', async () => {
  const c = await wellKnown('https://api.onrender.com', 200, { version: 1, resources: ['https://api.example.com/a'] });
  assert.equal(c.status, 'info');
  assert.match(c.message, /hosting platform address/);
  // but a platform address pointing at another platform address is a warning
  assert.equal((await wellKnown('https://new.onrender.com', 200, { version: 1, resources: ['https://old.onrender.com/a'] })).status, 'warn');
});

const PAYTO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
function bazaarItems() {
  return [
    { resource: 'https://svc.onrender.com/signal/:pair', accepts: [{ payTo: PAYTO }] },
    { resource: 'https://svc.onrender.com/scan', accepts: [{ payTo: PAYTO.toLowerCase() }] },
    { resource: 'https://svc.example.com/scan', accepts: [{ payTo: PAYTO }] },
    { resource: 'https://someone-else.com/signal/:pair', accepts: [{ payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' }] },
  ];
}
function loadedIndex() {
  return createBazaarIndex({ url: 'https://cdp.test/discovery', fetchImpl: async () => ({ ok: true, json: async () => ({ items: bazaarItems() }) }) });
}

test('bazaar index: listings match route templates and payTo, case-insensitively', async () => {
  const index = loadedIndex();
  assert.equal(await index.listings('https://svc.example.com/signal/BTC-USDT', [PAYTO]), null, 'not loaded yet: no answer');
  await index.refresh();
  assert.deepEqual(await index.listings('https://svc.example.com/signal/BTC-USDT', [PAYTO]), { here: false, elsewhere: ['https://svc.onrender.com'] });
  assert.deepEqual(await index.listings('https://svc.example.com/scan?interval=4h', [PAYTO.toLowerCase()]), { here: true, elsewhere: ['https://svc.onrender.com'] });
  assert.deepEqual(await index.listings('https://svc.example.com/levels/BTC-USDT', [PAYTO]), { here: false, elsewhere: [] });
});

test('bazaar-listing: here passes, only elsewhere warns, nowhere is info, unknown says nothing', async () => {
  const run = async (answer) => {
    const checks = [];
    await checkBazaarListing('https://svc.example.com/signal/BTC-USDT', { accepts: [{ payTo: PAYTO }] }, { listings: async () => answer }, checks);
    return checks.find((c) => c.id === 'bazaar-listing');
  };
  assert.equal((await run({ here: true, elsewhere: ['https://svc.onrender.com'] })).status, 'pass');
  const moved = await run({ here: false, elsewhere: ['https://svc.onrender.com'] });
  assert.equal(moved.status, 'warn');
  assert.match(moved.message, /only under https:\/\/svc\.onrender\.com, not under https:\/\/svc\.example\.com/);
  assert.equal((await run({ here: false, elsewhere: [] })).status, 'info');
  assert.equal(await run(null), undefined);
});

test('bazaar-last-payment: the index keeps the last settled payment; from 21 days the check warns that the Bazaar drops the route at 30', async () => {
  const day = 86400e3;
  const at = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString();
  const items = [
    { resource: 'https://svc.example.com/scan', accepts: [{ payTo: PAYTO }], quality: { lastCalledAt: at(25) } },
    { resource: 'https://svc.example.com/signal/:pair', accepts: [{ payTo: PAYTO }], quality: { lastCalledAt: at(3) } },
    { resource: 'https://svc.example.com/levels/:pair', accepts: [{ payTo: PAYTO }] },
  ];
  const index = createBazaarIndex({ url: 'https://cdp.test/discovery', fetchImpl: async () => ({ ok: true, json: async () => ({ items }) }) });
  await index.refresh();
  assert.equal((await index.listings('https://svc.example.com/scan', [PAYTO])).last_settled, items[0].quality.lastCalledAt);
  assert.equal((await index.listings('https://svc.example.com/levels/BTC-USDT', [PAYTO])).last_settled, undefined, 'no date from the Bazaar: no field');
  const run = async (url) => {
    const checks = [];
    await checkBazaarListing(url, { accepts: [{ payTo: PAYTO }] }, index, checks);
    return checks.find((c) => c.id === 'bazaar-last-payment');
  };
  const stale = await run('https://svc.example.com/scan');
  assert.equal(stale.status, 'warn');
  assert.match(stale.message, /25 days ago; it drops a route after 30 days without one \(in about 5 day\(s\)\)/);
  assert.match(stale.hint, /One settled payment/);
  const fresh = await run('https://svc.example.com/signal/BTC-USDT');
  assert.equal(fresh.status, 'pass');
  assert.match(fresh.message, /3 day\(s\) ago/);
  assert.equal(await run('https://svc.example.com/levels/BTC-USDT'), undefined, 'no date: nothing to judge');
  const { buildFixes } = require('../lib/recipes');
  const fixes = buildFixes({ url: 'https://svc.example.com/scan', checks: [stale], probes: [] });
  const fix = fixes.fixes.find((f) => f.recipe === 'bazaar-last-payment');
  assert.ok(fix, 'a fix recipe exists');
  assert.match(JSON.stringify(fix), /wrapFetchWithPayment\(fetch, client\)\(\\"https:\/\/svc\.example\.com\/scan\\"\)/);
});

test('diagnose: runs the Bazaar listing check when an index is given', async () => {
  const report = await diagnose(`${healthyUrl}/signal/BTC-USDT`, {
    safeFetch: createSafeFetch({ allowPrivate: true }),
    rpcUrl,
    evmRpcUrls: { [BASE]: rpcUrl },
    bazaarIndex: { listings: async () => ({ here: false, elsewhere: ['https://old.onrender.com'] }) },
  });
  const c = report.checks.find((x) => x.id === 'bazaar-listing');
  assert.equal(c.status, 'warn');
  assert.equal(c.group, 'discovery');
  assert.equal(report.checks.find((x) => x.id === 'well-known').status, 'info', 'the fixture serves no /.well-known/x402');
});

test('well-known: resources as objects with a url are read too', async () => {
  const doc = { x402Version: 2, kind: 'resource-server', resources: [{ url: 'https://api.example.com/sentiment/{symbol}', method: 'GET' }] };
  assert.equal((await wellKnown('https://api.example.com', 200, doc)).status, 'pass');
  assert.equal((await wellKnown('https://api.example.com', 200, { ...doc, resources: [{ url: 'https://old.onrender.com/sentiment/{symbol}' }] })).status, 'warn');
  // { resource } instead of { url }, as HelpMyAgent and x402lab publish it
  assert.equal((await wellKnown('https://api.example.com', 200, { resources: [{ resource: 'https://api.example.com/a', name: 'A', description: 'Does a.' }] })).status, 'pass');
});

test('well-known-names: info when resources have no name and description (directories list them by those)', async () => {
  const run = async (doc) => {
    const checks = [];
    await checkWellKnown('https://api.example.com', fakeFetch(200, doc), checks);
    return checks;
  };
  const bare = await run({ version: 1, resources: ['https://api.example.com/a', { url: 'https://api.example.com/b', name: 'B', description: 'Does b.' }] });
  assert.equal(bare.find((c) => c.id === 'well-known').status, 'pass');
  const names = bare.find((c) => c.id === 'well-known-names');
  assert.equal(names.status, 'info');
  assert.match(names.message, /^1 of 2 resource\(s\) in \/\.well-known\/x402 have no name and description/);
  assert.match(names.message, /XRPL AI Hub/);
  assert.match(names.hint, /"name": "Short name"/);
  assert.equal((await run({ version: 1, resources: [{ url: 'https://api.example.com/a', name: 'A', description: 'Does a.' }] })).find((c) => c.id === 'well-known-names'), undefined);
});

test('paywall: the testnet flag is read from JSON config too (as the Python x402 package writes it)', async () => {
  const page = (cfg) => async () => ({ status: 402, text: `<html><script>window.x402 = ${cfg};</script><script>var chain={testnet:!0};</script></html>`, headers: new Map() });
  const mainnet = [{ network: BASE }];
  const run = async (cfg) => {
    const checks = [];
    await checkPaywall('https://api.example.com/x', 'GET', mainnet, page(cfg), checks);
    return checks[0];
  };
  const jsonTestnet = await run('{"paymentRequired": {}, "amount": 0.01, "testnet": true}');
  assert.equal(jsonTestnet.status, 'fail');
  assert.equal((await run('{"testnet": false}')).message, 'Browser paywall present (mainnet mode).');
  assert.equal((await run('{"amount": 0.01}')).message, 'Browser paywall present.', 'no flag: the wallet code later in the page does not count');
});

test('ERC-8004 identity: verified when the registered agent points back to this domain; flagged when it points elsewhere or does not exist', async () => {
  const { checkAgentIdentity } = require('../lib/diagnose');
  const abiString = (s) => {
    const hex = Buffer.from(s).toString('hex');
    return `0x${'20'.padStart(64, '0')}${s.length.toString(16).padStart(64, '0')}${hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')}`;
  };
  let site = null;
  const rpc = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const id = parseInt(body.params[0].data.slice(10), 16);
    res.setHeader('content-type', 'application/json');
    if (id === 7) res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: abiString(`${site}/.well-known/agent-registration.json`) }));
    else if (id === 8) res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: abiString('https://someone-else.example/agent.json') }));
    else res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted: ERC721NonexistentToken' } }));
  });
  let doc = null;
  site = await listen((req, res) => {
    if (req.url !== '/.well-known/agent-registration.json' || !doc) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(doc));
  });
  const safeFetch = createSafeFetch({ allowPrivate: true });
  const run = async () => { const checks = []; await checkAgentIdentity(site, safeFetch, checks, { evmRpcUrls: { [BASE]: rpc } }); return checks[0]; };
  const REG = 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
  const base = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Test service', services: [] };

  assert.equal((await run()).status, 'info', 'no file: optional');
  doc = { hello: 'world' };
  assert.equal((await run()).status, 'warn', 'not an ERC-8004 file');
  doc = { ...base, registrations: [{ agentId: 'abc', agentRegistry: 'solana:101:metaplex' }] };
  const solOnly = await run();
  assert.equal(solOnly.status, 'info');
  assert.match(solOnly.message, /Solana registry/);
  doc = { ...base, registrations: [{ agentId: 7, agentRegistry: REG }] };
  const ok = await run();
  assert.equal(ok.status, 'pass');
  assert.match(ok.message, /agent #7 on Base/);
  doc = { ...base, registrations: [{ agentId: 8, agentRegistry: REG }] };
  const other = await run();
  assert.equal(other.status, 'warn');
  assert.match(other.message, /points to https:\/\/someone-else\.example/);
  doc = { ...base, registrations: [{ agentId: 99, agentRegistry: REG }] };
  const missing = await run();
  assert.equal(missing.status, 'warn');
  assert.match(missing.message, /doesn't exist/);
});

test("Coinbase's agents: payable with USDC on Base (exact/upto), the v2 and $5 limits of the Coinbase MCP, none without Base USDC", () => {
  const { checkCoinbaseAgents } = require('../lib/diagnose');
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const run = (challenge, opts) => { const checks = []; checkCoinbaseAgents(challenge, checks, opts); return checks[0]; };
  const opt = (over) => ({ scheme: 'exact', network: BASE, asset: USDC, amount: '10000', payTo: '0x1111111111111111111111111111111111111111', ...over });

  const ok = run({ x402Version: 2, accepts: [opt()] });
  assert.equal(ok.status, 'pass');
  assert.match(ok.message, /Coinbase Wallet MCP agents can pay this \(USDC on Base, "exact"\)/);
  assert.match(ok.message, /fetches only services in its own curated catalog/);
  assert.match(ok.message, /CDP Bazaar search once it is listed there\./, 'without the Bazaar index it says how a listing gets made');
  assert.match(run({ x402Version: 2, accepts: [opt()] }, { listing: 'pass' }).message, /CDP Bazaar search, where it is listed\./);
  assert.match(run({ x402Version: 2, accepts: [opt()] }, { listing: 'warn' }).message, /finds it only under another host \(see bazaar-listing\)\./);
  assert.match(run({ x402Version: 2, accepts: [opt()] }, { listing: 'info' }).message, /can't find it yet: it is not listed there/);
  const pricey = run({ x402Version: 1, accepts: [opt({ scheme: 'upto', amount: undefined, maxAmountRequired: '7500000' })] });
  assert.equal(pricey.status, 'pass');
  assert.match(pricey.message, /"upto".*But the Coinbase MCP fetches x402 v2 only, and this is v1; the Coinbase MCP pays at most \$5 a call, and this asks \$7\.5\./);
  const solanaOnly = run({ x402Version: 2, accepts: [opt({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })] });
  assert.deepEqual([solanaOnly.id, solanaOnly.status], ['coinbase-agents', 'info']);
  assert.match(solanaOnly.hint, /eip155:8453/);
  const batchOnly = run({ x402Version: 2, accepts: [opt({ scheme: 'batch-settlement' })] });
  assert.equal(batchOnly.status, 'info');
  assert.match(batchOnly.message, /"batch-settlement" scheme/);
});

test('skill.md: found, llms.txt as the older form, an HTML homepage on every path does not count, none is info', async () => {
  const { checkSkillMd } = require('../lib/diagnose');
  let files = {};
  const site = await listen((req, res) => {
    const f = files[req.url];
    if (!f) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', f.type);
    res.end(f.body);
  });
  const safeFetch = createSafeFetch({ allowPrivate: true });
  const run = async () => { const checks = []; await checkSkillMd(site, safeFetch, checks); return checks[0]; };
  const host = new URL(site).hostname;

  files = { '/skill.md': { type: 'text/markdown', body: '# Example API\n\nPaid with x402: GET /v1/thing costs $0.01 USDC on Base.' } };
  const found = await run();
  assert.equal(found.status, 'pass');
  assert.equal(found.message, `/skill.md found: a user can tell an agent "connect to ${host}/skill.md" and it learns how to call your API and pay for it.`);
  files = { '/llms.txt': { type: 'text/plain', body: '# Example API\n> What it does' } };
  assert.match((await run()).message, /^\/llms\.txt found \(no \/skill\.md\)/);
  files = { '/skill.md': { type: 'text/html', body: '<!doctype html><html><body>Home</body></html>' }, '/llms.txt': { type: 'text/html', body: '<html>Home</html>' } };
  const spa = await run();
  assert.deepEqual([spa.id, spa.status], ['agent-instructions', 'info'], 'a homepage served on every path is not a skill.md');
  assert.match(spa.hint, /Serve Markdown at \/skill\.md/);
  files = {};
  assert.equal((await run()).status, 'info');
});

test('MPP: a WWW-Authenticate: Payment challenge is read and checked; MPP-only is not "broken"; both protocols are noted', async () => {
  const { parseChallenges } = require('../lib/mpp');
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const tempo = { amount: '10000', currency: '0x20c0000000000000000000000000000000000000', recipient: '0x1111111111111111111111111111111111111111' };
  const stripe = { amount: '100', currency: 'usd', methodDetails: { networkId: 'profile_123', paymentMethodTypes: ['card'] } };

  // The parser: several challenges in one header, quoted strings with escapes, a token value.
  const two = parseChallenges(`Payment id="a1", realm="api.example.com", method="tempo", intent=charge, request="${b64u(tempo)}", description="say \\"hi\\"", Payment id="b2", realm="api.example.com", method="stripe", intent="charge", request="${b64u(stripe)}"`);
  assert.deepEqual(two.map((c) => [c.params.id, c.params.method, c.params.intent]), [['a1', 'tempo', 'charge'], ['b2', 'stripe', 'charge']]);
  assert.equal(two[0].params.description, 'say "hi"');
  assert.equal(two[0].request.amount, '10000');
  assert.match(parseChallenges('Payment id="x", realm="h", method="tempo", intent="charge", request="not base64!"')[0].error, /base64url/);

  let mode = 'mpp-good';
  const seenTestAgents = new Set();
  const api = await listen((req, res) => {
    const host = 'localhost';
    const credential = req.headers.authorization;
    if (credential) seenTestAgents.add(req.headers['user-agent']);
    const good = `Payment id="c1", realm="${host}", method="tempo", intent="charge", request="${b64u(tempo)}", expires="${soon}"`;
    if (mode === 'mpp-good') {
      res.statusCode = 402;
      res.setHeader('www-authenticate', good + `, Payment id="c2", realm="${host}", method="stripe", intent="charge", request="${b64u(stripe)}", expires="${soon}"`);
      return res.end('{}');
    }
    if (mode === 'mpp-bad') {
      if (credential) { res.statusCode = 500; return res.end('boom'); }
      res.statusCode = 402;
      res.setHeader('www-authenticate', `Payment id="c1", realm="elsewhere.example", method="evm", intent="charge", request="${b64u({ amount: '1.5', currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', recipient: '0x1111111111111111111111111111111111111111' })}"`);
      return res.end('{}');
    }
    if (mode === 'both') {
      res.statusCode = 402;
      res.setHeader('www-authenticate', good);
      res.setHeader('payment-required', Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: `http://${req.headers.host}/paid` }, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: USDC_BASE, payTo: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] })).toString('base64'));
      return res.end('{}');
    }
  });
  const safeFetch = createSafeFetch({ allowPrivate: true });
  const run = () => diagnose(`${api.replace('127.0.0.1', 'localhost')}/paid`, { safeFetch, method: 'GET', rpcUrl: 'http://127.0.0.1:1', evmRpcUrls: {} });
  const byId = (report, id) => report.checks.filter((c) => c.id === id);

  const good = await run();
  assert.equal(byId(good, 'protocol-version')[0].status, 'info', 'no x402 challenge is not a failure when MPP is there');
  assert.equal(byId(good, 'mpp-challenge')[0].status, 'pass');
  assert.match(byId(good, 'mpp-challenge')[0].message, /2 payment options: tempo\/charge, stripe\/charge/);
  assert.deepEqual(byId(good, 'mpp-fields').map((c) => c.status), ['pass', 'pass']);
  assert.match(byId(good, 'mpp-fields')[1].message, /1\.00 USD via Stripe/);
  assert.equal(byId(good, 'mpp-bad-credential')[0].status, 'pass');
  assert.deepEqual([...seenTestAgents], ['x402-doctor (MPP bad-credential test)'], 'the bad-credential test names itself, so sellers can tell it from a real refused payment');
  assert.ok(!good.checks.some((c) => c.group === 'mpp' && c.status === 'fail'));
  assert.equal(good.mpp.length, 2);

  mode = 'mpp-bad';
  const bad = await run();
  assert.equal(bad.overall, 'fail');
  assert.equal(byId(bad, 'mpp-realm')[0].status, 'warn');
  assert.equal(byId(bad, 'mpp-expires')[0].status, 'warn');
  assert.equal(byId(bad, 'mpp-amount')[0].status, 'fail');
  assert.equal(byId(bad, 'mpp-chain')[0].status, 'fail');
  assert.equal(byId(bad, 'mpp-bad-credential')[0].status, 'fail');

  mode = 'both';
  const both = await run();
  assert.equal(byId(both, 'protocols')[0].status, 'pass');
  assert.match(byId(both, 'protocols')[0].message, /both x402 and MPP \(tempo\)/);
  assert.equal(byId(both, 'protocol-version')[0].status, 'pass');
});

test('upto scheme: EVM needs facilitatorAddress and permit2, buyers are told about Permit2; Solana needs receiverAuthorizer', () => {
  const checks = [];
  const base = { network: 'eip155:8453', amount: '100000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F', maxTimeoutSeconds: 300 };
  checkAccepts([
    { scheme: 'upto', ...base, extra: { assetTransferMethod: 'permit2', facilitatorAddress: '0x1111111111111111111111111111111111111111' } },
    { scheme: 'upto', ...base, extra: { assetTransferMethod: 'permit2' } },
    { scheme: 'upto', ...base, extra: { assetTransferMethod: 'eip3009', facilitatorAddress: '0x1111111111111111111111111111111111111111' } },
    { scheme: 'upto', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '100000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9', maxTimeoutSeconds: 300, extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } },
  ], checks);
  const get = (id) => checks.find((c) => c.id === id);
  assert.equal(get('accepts[0]-extra').status, 'pass');
  assert.equal(get('accepts[0]-scheme'), undefined, 'upto is a known scheme');
  assert.equal(get('accepts[0]-upto').status, 'info');
  assert.match(get('accepts[0]-upto').message, /Permit2 approval/);
  assert.equal(get('accepts[1]-extra').status, 'fail');
  assert.match(get('accepts[1]-extra').message, /facilitatorAddress/);
  assert.equal(get('accepts[2]-extra').status, 'warn');
  assert.equal(get('accepts[3]-upto').status, 'fail');
  assert.match(get('accepts[3]-upto').message, /receiverAuthorizer/);
});

test('upto proxy: fail when it has no code on the network, pass when deployed, silent when the RPC does not answer', async (t) => {
  const { checkUptoProxy } = require('../lib/diagnose');
  let reply = '0x';
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(reply === null ? '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"down"}}' : JSON.stringify({ jsonrpc: '2.0', id: 1, result: reply })); }); }).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  // RPC answers are cached per URL for 10 minutes: one URL per case.
  const rpcs = (tag) => ({ 'eip155:8453': `http://127.0.0.1:${server.address().port}/${tag}` });
  const option = { scheme: 'upto', network: 'eip155:8453', amount: '1', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F' };
  let checks = [];
  await checkUptoProxy([option], checks, { evmRpcUrls: rpcs('empty') });
  assert.equal(checks.find((c) => c.id === 'upto-proxy').status, 'fail');
  reply = '0x6080604052';
  checks = [];
  await checkUptoProxy([option, { ...option, scheme: 'exact' }], checks, { evmRpcUrls: rpcs('deployed') });
  assert.deepEqual(checks.map((c) => [c.id, c.status]), [['upto-proxy', 'pass']]);
  reply = null;
  checks = [];
  await checkUptoProxy([option], checks, { evmRpcUrls: rpcs('down') });
  assert.deepEqual(checks, []);
});

test('description quality: opt-in, an info line from the describe judge, verdict unchanged', async () => {
  const seen = [];
  const describe = { enabled: true, rate: async (d) => { seen.push(d); return { score: 0.5, says_output: 0.1, says_when: 0.2 }; } };
  const plain = await diagnose(`${healthyUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl });
  const rated = await diagnose(`${healthyUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl, describe });
  assert.equal(plain.checks.some((c) => c.id === 'description-quality'), false);
  const line = rated.checks.find((c) => c.id === 'description-quality');
  assert.equal(line.status, 'info');
  assert.equal(line.group, 'resource');
  assert.equal(typeof seen[0], 'string');
  assert.equal(rated.overall, plain.overall);
});

test('market price: opt-in, an info line from the price comparison, asked with the lowest USDC price, verdict unchanged', async () => {
  const seen = [];
  const cmp = { price_usd: 0.02, comparable_median_usd: 0.01, comparables: 6, ratio: 2, range_usd: [0.005, 0.05], cheaper: [] };
  const price = (result) => ({ enabled: true, compare: async (url, args) => { seen.push({ url, ...args }); return result; } });
  const plain = await diagnose(`${healthyUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl });
  const priced = await diagnose(`${healthyUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl, price: price(cmp) });
  assert.equal(plain.checks.some((c) => c.id === 'market-price'), false);
  const line = priced.checks.find((c) => c.id === 'market-price');
  assert.equal(line.status, 'info');
  assert.equal(line.group, 'discovery');
  assert.match(line.message, /\$0\.02 is 2x the median of \$0\.01 across 6 comparable/);
  assert.equal(typeof seen[0].description, 'string');
  assert.ok(seen[0].priceUsd > 0);
  assert.equal(priced.overall, plain.overall);
  // No comparison, or a failing one: no line, nothing breaks.
  assert.equal((await diagnose(`${healthyUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl, price: price(null) })).checks.some((c) => c.id === 'market-price'), false);
  const broken = { enabled: true, compare: async () => { throw new Error('down'); } };
  assert.equal((await diagnose(`${healthyUrl}/signal/BTC-USDT`, { safeFetch, rpcUrl, price: broken })).overall, plain.overall);
});

test('more EVM chains with native USDC are known: World Chain, Monad, HyperEVM, Ethereum, Unichain, Sei', () => {
  const opt = (network, asset) => ({ scheme: 'exact', network, asset, amount: '15000', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F', maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } });
  const checks = [];
  checkAccepts([
    opt('eip155:480', '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1'),
    opt('eip155:143', '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
    opt('eip155:999', '0xb88339CB7199b77E23DB6E890353E22632Ba630f'),
    opt('eip155:1', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    opt('eip155:480', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  ], checks);
  const status = (id) => checks.find((c) => c.id === id)?.status;
  for (const i of [0, 1, 2, 3]) { assert.equal(status(`accepts[${i}]-network`), 'pass'); assert.equal(status(`accepts[${i}]-asset`), undefined); }
  assert.match(checks.find((c) => c.id === 'accepts[0]-amount').message, /\$0\.015 USDC/);
  assert.equal(status('accepts[4]-asset'), 'fail', 'Ethereum USDC on World Chain is a mismatch');
});

test('batch-settlement: an option as the SDK builds it passes; receiverAuthorizer, withdrawDelay and the deposit domain are checked', async () => {
  const { x402ResourceServer } = require('@x402/core/server');
  const { BatchSettlementEvmScheme } = require('@x402/evm/batch-settlement/server');
  const payTo = '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F';
  const facilitator = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'batch-settlement', network: 'eip155:8453', extra: { receiverAuthorizer: '0x1111111111111111111111111111111111111111' } }], extensions: [], signers: {} }),
    verify: async () => ({ isValid: false }),
    settle: async () => ({ success: false }),
  };
  const server = new x402ResourceServer([facilitator]).register('eip155:8453', new BatchSettlementEvmScheme(payTo, { withdrawDelay: 86400 }));
  await server.initialize();
  const [sdk] = await server.buildPaymentRequirements({ scheme: 'batch-settlement', price: '$0.001', network: 'eip155:8453', payTo });
  const { receiverAuthorizer, ...noAuthorizer } = sdk.extra;
  const { withdrawDelay, ...noDelay } = sdk.extra;
  const checks = [];
  checkAccepts([
    sdk,
    { ...sdk, extra: noAuthorizer },
    { ...sdk, extra: { ...sdk.extra, withdrawDelay: 60 } },
    { ...sdk, extra: noDelay },
    { ...sdk, extra: { receiverAuthorizer, withdrawDelay } },
    { ...sdk, extra: { receiverAuthorizer, withdrawDelay, assetTransferMethod: 'permit2' } },
    { scheme: 'batch-settlement', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', amount: '1000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9', extra: { feePayer: 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww' } },
  ], checks);
  const get = (id) => checks.find((c) => c.id === id);
  assert.equal(get('accepts[0]-scheme'), undefined, 'batch-settlement is a known scheme');
  assert.equal(get('accepts[0]-extra').status, 'pass');
  assert.equal(checks.filter((c) => c.id.startsWith('accepts[0]') && c.status === 'fail').length, 0);
  assert.match(get('accepts[0]-batch').message, /deposits once of at least \$0\.01 into the x402 escrow/);
  assert.match(get('accepts[0]-batch').message, /\(24 h\)/);
  assert.equal(get('accepts[1]-extra').status, 'fail');
  assert.match(get('accepts[1]-extra').message, /receiverAuthorizer/);
  assert.equal(get('accepts[2]-batch-delay').status, 'fail');
  assert.equal(get('accepts[3]-batch-delay').status, 'warn');
  assert.equal(get('accepts[4]-batch-deposit').status, 'fail', 'no EIP-712 domain for the EIP-3009 deposit');
  assert.equal(get('accepts[5]-batch-deposit'), undefined, 'Permit2 deposits need no EIP-712 domain of the token');
  assert.equal(get('accepts[6]-extra').status, 'pass', 'Solana still needs the fee payer');
  assert.equal(get('accepts[6]-batch').status, 'info');
});

test('batch-settlement: browser wallets cannot pay it, x402 agents need a batch-settlement client', () => {
  const { walletCompatibility } = require('../lib/wallets');
  const option = { scheme: 'batch-settlement', network: 'eip155:8453', amount: '1000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F' };
  const wallets = walletCompatibility([option], []);
  const metamask = wallets.find((w) => w.wallet === 'MetaMask');
  assert.equal(metamask.yes.length, 0);
  assert.match(metamask.no[0].reason, /batch-settlement/);
  const agent = wallets.find((w) => w.agent);
  assert.ok(agent.yes.length > 0);
  assert.match(agent.needs.join(' '), /batch-settlement client/);
});

test('batch-settlement escrow: fail when it has no code on the network, pass when deployed', async (t) => {
  const { checkBatchEscrow } = require('../lib/diagnose');
  let reply = '0x';
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(b).id, result: reply })); }); }).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const rpcs = (tag) => ({ 'eip155:8453': `http://127.0.0.1:${server.address().port}/${tag}` });
  const option = { scheme: 'batch-settlement', network: 'eip155:8453', amount: '1', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F' };
  let checks = [];
  await checkBatchEscrow([option], checks, { evmRpcUrls: rpcs('batch-empty') });
  assert.equal(checks.find((c) => c.id === 'batch-escrow').status, 'fail');
  reply = '0x6080604052';
  checks = [];
  await checkBatchEscrow([option, { ...option, scheme: 'exact' }], checks, { evmRpcUrls: rpcs('batch-deployed') });
  assert.deepEqual(checks.map((c) => [c.id, c.status]), [['batch-escrow', 'pass']]);
});

test('merchant: the x402-merchant extension is checked, and its absence noted only when Algorand is offered', () => {
  const ALGO = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
  const run = (challenge) => { const checks = []; checkMerchant(challenge, checks); return checks; };
  const merchant = (info) => ({ 'x402-merchant': { info, schema: { type: 'object', required: ['name'] } } });
  assert.deepEqual(run({ accepts: [{ network: 'eip155:8453' }] }), [], 'nothing to say without Algorand');
  const missing = run({ accepts: [{ network: 'eip155:8453' }, { network: ALGO }] });
  assert.deepEqual(missing.map((c) => [c.id, c.status]), [['merchant', 'info']]);
  assert.match(missing[0].message, /GoPlausible/);
  const good = run({ accepts: [{ network: ALGO }], extensions: merchant({ name: 'Fizzl', website: 'https://fizzl.eu', logo: 'https://fizzl.eu/logo-512.png', categories: ['x402'] }) });
  assert.deepEqual(good.map((c) => [c.status, c.message]), [['pass', 'x402-merchant extension names the seller: Fizzl.']]);
  assert.match(run({ accepts: [], extensions: merchant({ name: 'Shop' }) })[0].message, /Shop \(no website or logo\)/);
  const bad = run({ accepts: [{ network: 'eip155:8453' }], extensions: merchant({ website: 'http://x.example', logo: 'logo.png', categories: 'data' }) });
  assert.equal(bad[0].status, 'warn', 'a malformed one is a warning on any network');
  assert.match(bad[0].message, /info\.name is missing; info\.website is not an https URL; info\.logo is not an https URL; info\.categories is not a list of strings/);
});

test('builder code: a valid declaration passes, its absence on Base is noted, a code the facilitator would drop is a warning', () => {
  const { declareBuilderCodeExtension } = require('@x402/extensions/builder-code');
  const run = (challenge) => { const checks = []; checkBuilderCode({ x402Version: 2, ...challenge }, checks); return checks.map((c) => [c.status, c.message]); };
  const BASE = [{ network: 'eip155:8453' }];
  assert.deepEqual(run({ accepts: BASE, extensions: { 'builder-code': declareBuilderCodeExtension('bc_pzrclpac') } }), [['pass', "Base Builder Code bc_pzrclpac: the buyer's x402 client echoes it and the facilitator writes it into the settlement, so Base attributes the payment to your app."]]);
  const missing = run({ accepts: BASE });
  assert.equal(missing[0][0], 'info');
  assert.match(missing[0][1], /No Base Builder Code/);
  assert.deepEqual(run({ accepts: [{ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }] }), [], 'nothing to say without Base');
  assert.match(run({ accepts: BASE, extensions: { 'builder-code': { a: 'bc_x' } } })[0][1], /not under info, so x402 clients echo nothing/);
  assert.match(run({ accepts: BASE, extensions: { 'builder-code': { info: { a: 'Fizzl-EU' } } } })[0][1], /info\.a "Fizzl-EU" is not a valid code/);
  assert.match(run({ accepts: BASE, extensions: { 'builder-code': { info: {} } } })[0][1], /info\.a \(the app code\) is missing/);
  const services = run({ accepts: BASE, extensions: { 'builder-code': { info: { a: 'bc_x', s: ['ok', 'Not-OK'] } } } });
  assert.equal(services[0][0], 'warn');
  assert.match(services[0][1], /1 of the service codes in info\.s is not valid.*The app code itself still counts/);
  assert.match(run({ accepts: BASE, extensions: { 'builder-code': { info: { a: 'bc_x', s: ['a', 'b', 'c', 'd', 'e', 'f'] } } } })[0][1], /6 service codes, more than the 5/);
  assert.deepEqual(run({ accepts: [{ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }], extensions: { 'builder-code': declareBuilderCodeExtension('bc_x') } }).map((c) => c[0]), ['info']);
  const v1 = run({ x402Version: 1, accepts: BASE, extensions: { 'builder-code': declareBuilderCodeExtension('bc_x') } });
  assert.equal(v1[0][0], 'warn');
  assert.match(v1[0][1], /x402 v1 challenge: the facilitator only reads the app code from v2 payments/);
});

test('Bazaar example without a route template: replayed on the listed URL with its query and body; no input declared gets a hint', async () => {
  const { checkBazaar } = require('../lib/diagnose');
  const plain = declareDiscoveryExtension({ method: 'GET', input: { symbol: 'BTC' }, inputSchema: { properties: { symbol: { type: 'string' } }, required: ['symbol'] } }).bazaar;
  const seen = [];
  const fetchStub = (status) => async (url, init = {}) => { seen.push({ url, method: init.method, body: init.body }); return new Response(null, { status }); };
  const run = async (bz, status, url = 'https://api.example.com/v1/price') => {
    const checks = [];
    await checkBazaar({ extensions: { bazaar: bz } }, new URL(url).origin, fetchStub(status), checks, url);
    return Object.fromEntries(checks.map((c) => [c.id, c]));
  };

  const ok = await run(plain, 402);
  assert.equal(ok['bazaar-replay'].status, 'pass');
  assert.match(ok['bazaar-replay'].message, /GET \/v1\/price\?symbol=BTC\) answers 402/);
  assert.equal(seen.at(-1).url, 'https://api.example.com/v1/price?symbol=BTC');
  assert.equal(ok['bazaar-input'], undefined, 'input declared: no hint');

  const bad = await run(plain, 400);
  assert.equal(bad['bazaar-replay'].status, 'warn');
  assert.match(bad['bazaar-replay'].message, /HTTP 400, not 402/);

  const post = declareDiscoveryExtension({ method: 'POST', bodyType: 'json', input: { code: '1+1' }, inputSchema: { properties: { code: { type: 'string' } } } }).bazaar;
  await run(post, 402, 'https://api.example.com/v1/run');
  assert.equal(seen.at(-1).method, 'POST');
  assert.deepEqual(JSON.parse(seen.at(-1).body), post.info.input.body);

  const none = declareDiscoveryExtension({ method: 'GET', output: { example: { price: 1 } } }).bazaar;
  const before = seen.length;
  const hint = await run(none, 402);
  assert.equal(hint['bazaar-input'].status, 'info');
  assert.match(hint['bazaar-input'].hint, /before you settle/);
  assert.equal(hint['bazaar-replay'], undefined, 'nothing to replay');
  assert.equal(seen.length, before, 'no request sent without an example');
});

test('Bazaar routeTemplate that is not a path, or with a :param without a value: a warning, and the listed URL instead', async () => {
  const { checkBazaar, routeTemplateProblem, exampleRequest } = require('../lib/diagnose');
  const input = { type: 'http', method: 'GET', queryParams: {}, pathParams: {} };
  assert.match(routeTemplateProblem({ routeTemplate: ':var1', info: { input } }), /":var1" is not a path/);
  assert.match(routeTemplateProblem({ routeTemplate: '/coin/:id/:range', info: { input: { ...input, pathParams: { id: 'btc' } } } }), /has :range without a value/);
  assert.equal(routeTemplateProblem({ routeTemplate: '/signal/:pair', info: { input: { ...input, pathParams: { pair: 'BTC-USDT' } } } }), null);
  assert.equal(routeTemplateProblem({ info: { input } }), null, 'no template, nothing to say');

  // Seen in the wild (riddlex402.vercel.app): routeTemplate ":var1" made the check fail with "Invalid URL".
  const bz = declareDiscoveryExtension({ method: 'GET', output: { example: { riddle: 'r' } } }).bazaar;
  const broken = { ...bz, routeTemplate: ':var1' };
  const seen = [];
  const checks = [];
  await checkBazaar({ extensions: { bazaar: broken } }, 'https://riddle.example', async (url) => { seen.push(url); return new Response(null, { status: 402 }); }, checks, 'https://riddle.example/api/riddle');
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(byId['bazaar-route'].status, 'warn');
  assert.match(byId['bazaar-route'].message, /routeTemplate ":var1" is not a path/);
  assert.equal(seen.length, 0, 'no example values: nothing replayed');
  // With example values the listed URL stands in for the broken template (also for the spot-buy).
  const withQuery = { ...broken, info: { ...broken.info, input: { ...broken.info.input, queryParams: { level: 'easy' } } } };
  assert.deepEqual(exampleRequest('https://riddle.example/api/riddle', withQuery), { url: 'https://riddle.example/api/riddle?level=easy', method: 'GET' });
});

test('Nevermined plans: no payTo or amount asked; the rail, the plan id and the agent id are', () => {
  const checks = [];
  const plan = '44742763076047497640080230236781474129970992727896593861997347135613135571071';
  const agent = { version: '1', agentId: '80918427023170428029540261117198154464497879145267720259488529685089104529015' };
  checkAccepts([
    { scheme: 'nvm:erc4337', network: 'eip155:84532', planId: plan, extra: agent },
    { scheme: 'nvm:card-delegation', network: 'stripe', planId: plan, extra: agent },
    { scheme: 'nvm:erc4337', network: 'sandbox', planId: plan, extra: agent }, // an environment, not a rail
    { scheme: 'nvm:card-delegation', network: 'eip155:8453', planId: 'basic', extra: {} }, // wrong rail, no plan id
    { scheme: 'nvm:erc4337', network: 'eip155:8453', planId: plan }, // no agent id
    { scheme: 'nvm:erc4337', network: 'eip155:8453', planId: 123, extra: { agentId: 456 } }, // ids as JSON numbers
  ], checks);
  const get = (id) => checks.find((c) => c.id === id);
  for (const i of [0, 1]) {
    assert.equal(get(`accepts[${i}]-scheme`).status, 'info');
    assert.match(get(`accepts[${i}]-scheme`).message, /Nevermined plan/);
    assert.equal(get(`accepts[${i}]-network`).status, 'pass');
    assert.equal(get(`accepts[${i}]-plan`).status, 'pass');
    assert.equal(get(`accepts[${i}]-payto`), undefined);
    assert.equal(get(`accepts[${i}]-amount`), undefined);
  }
  assert.match(get('accepts[0]-network').message, /Base Sepolia/);
  assert.equal(get('accepts[2]-network').status, 'fail');
  assert.match(get('accepts[2]-network').message, /environment/);
  assert.equal(get('accepts[3]-network').status, 'warn');
  assert.equal(get('accepts[3]-plan').status, 'fail');
  assert.equal(get('accepts[4]-plan').status, 'warn');
  assert.equal(get('accepts[5]-plan').status, 'pass');
});

test('Circle Gateway testnets (as @circle-fin/x402-batching lists them) are known networks with their USDC', () => {
  const checks = [];
  const payTo = '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F';
  const gw = { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x0077777d7eba4688bdef3e311b846f25870a19b9' };
  const testnets = [
    ['eip155:11155111', '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'], ['eip155:421614', '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'],
    ['eip155:11155420', '0x5fd84259d66cd46123540766be93dfe6d43130d7'], ['eip155:1301', '0x31d0220469e10c4e71834a79b1f276d740d3768f'],
    ['eip155:4801', '0x66145f38cbac35ca6f1dfb4914df98f1614aea88'], ['eip155:1328', '0x4fcf1784b31630811181f670aea7a7bef803eaed'],
    ['eip155:998', '0x2b3370ee501b4a559b57d449569354196457d8ab'], ['eip155:14601', '0x0ba304580ee7c9a980cf72e55f5ed2e9fd30bc51'],
  ];
  checkAccepts(testnets.map(([network, asset]) => ({ scheme: 'exact', network, asset, amount: '10000', payTo, maxTimeoutSeconds: 604900, extra: gw })), checks);
  testnets.forEach((_, i) => {
    assert.equal(checks.find((c) => c.id === `accepts[${i}]-network`).status, 'pass', JSON.stringify(checks.filter((c) => c.id.startsWith(`accepts[${i}]`))));
    assert.ok(!checks.some((c) => c.id === `accepts[${i}]-asset` && c.status !== 'pass'), `accepts[${i}] asset is that testnet's USDC`);
  });
});

test('unknown schemes: missing or unusual fields are warnings, a burn address a fail; "eip3009" as scheme gets the hint', () => {
  const checks = [];
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const payTo = '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F';
  checkAccepts([
    { scheme: 'aggr_deferred', network: 'eip155:8453' }, // nothing the doctor can judge
    { scheme: 'settled-transfer', network: 'eip155:8453', asset: usdc, payTo, amount: '10000' },
    { scheme: 'memo-transfer', network: 'eip155:8453', asset: usdc, payTo: '0x0000000000000000000000000000000000000000', amount: '10000' },
    { scheme: 'eip3009', network: 'eip155:8453', asset: usdc, payTo, amount: '10000' },
    { scheme: 'exact', network: 'eip155:8453', asset: usdc, amount: '10000', extra: { name: 'USD Coin', version: '2' } }, // exact: still a fail
  ], checks);
  const get = (id) => checks.find((c) => c.id === id);
  assert.equal(get('accepts[0]-scheme').status, 'warn');
  assert.equal(get('accepts[0]-payto').status, 'warn');
  assert.match(get('accepts[0]-payto').message, /doesn't know what "aggr_deferred" requires/);
  assert.equal(get('accepts[0]-amount').status, 'warn');
  assert.equal(get('accepts[1]-payto').status, 'pass');
  assert.equal(get('accepts[1]-amount').status, 'pass');
  assert.equal(get('accepts[2]-payto').status, 'fail');
  assert.match(get('accepts[3]-scheme').message, /EIP-3009/);
  assert.equal(get('accepts[3]-scheme').hint, 'Set "scheme": "exact".');
  assert.equal(get('accepts[4]-payto').status, 'fail');
  assert.ok(!checks.some((c) => /^accepts\[[0-3]\]/.test(c.id) && c.status === 'fail' && c.id !== 'accepts[2]-payto'), JSON.stringify(checks.filter((c) => c.status === 'fail')));
});

test('resource.url as a path is judged against the endpoint: a warning, and a mismatch only when the path differs', () => {
  const challenge = (url) => ({ x402Version: 2, resource: { url, description: 'x', mimeType: 'application/json' }, accepts: [] });
  let checks = [];
  checkResource(challenge('/api/v1/tasks'), 'https://agent.example/api/v1/tasks', checks);
  let c = checks.find((x) => x.id === 'resource-url');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /matches/);
  assert.doesNotMatch(c.message, /differs/);
  checks = [];
  checkResource(challenge('/api/v1/other'), 'https://agent.example/api/v1/tasks', checks);
  assert.match(checks.find((x) => x.id === 'resource-url').message, /differs/);
  checks = [];
  checkResource(challenge('api/v1/tasks'), 'https://agent.example/api/v1/tasks', checks);
  assert.equal(checks.find((x) => x.id === 'resource-url').status, 'fail');
});

test('BNB Chain: 18-decimal dollar tokens, EIP-3009 vs Permit2, the token domain and a 6-decimal amount', () => {
  const checks = [];
  const payTo = '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F';
  const bnb = (asset, extra, amount = '10000000000000000') => ({ scheme: 'exact', network: 'eip155:56', amount, asset, payTo, maxTimeoutSeconds: 60, extra });
  checkAccepts([
    bnb('0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', { name: 'World Liberty Financial USD', version: '1', assetTransferMethod: 'eip3009' }), // USD1: fine
    bnb('0x55d398326f99059fF775485246999027B3197955', { name: 'Tether USD', version: '1' }), // USDT has no EIP-3009
    bnb('0x55d398326f99059fF775485246999027B3197955', { name: 'Tether USD', version: '1', assetTransferMethod: 'permit2-exact' }), // not a standard value
    bnb('0xcE24439F2D9C6a2289F741120FE202248B666666', { name: 'United Stables', version: '2' }), // wrong domain version
    bnb('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', { assetTransferMethod: 'permit2' }), // Binance-Peg USDC via Permit2: fine
    bnb('0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', { name: 'World Liberty Financial USD', version: '1' }, '10000'), // written for 6 decimals
    bnb('0x1111111111111111111111111111111111111111', { name: 'X', version: '1' }), // unknown token
  ], checks);
  const get = (id) => checks.find((c) => c.id === id);
  assert.equal(get('accepts[0]-network').status, 'pass');
  assert.match(get('accepts[0]-network').message, /BNB Chain/);
  assert.equal(get('accepts[0]-asset'), undefined);
  assert.match(get('accepts[0]-amount').message, /\$0\.01 USD1/);
  assert.equal(get('accepts[0]-extra').status, 'pass');
  assert.equal(get('accepts[1]-extra').status, 'fail');
  assert.match(get('accepts[1]-extra').message, /USDT on BNB Chain has no transferWithAuthorization/);
  assert.equal(get('accepts[2]-extra').status, 'warn');
  assert.match(get('accepts[2]-extra').message, /"permit2-exact" is a method of Binance's B402 facilitator, not one standard x402 clients know.*USDT on BNB Chain doesn't support, so only B402 clients can pay it/);
  assert.equal(get('accepts[2]-permit2').status, 'info');
  assert.equal(get('accepts[3]-extra').status, 'fail');
  assert.match(get('accepts[3]-extra').message, /signs as "United Stables" v1/);
  assert.equal(get('accepts[4]-extra').status, 'pass');
  assert.match(get('accepts[4]-permit2').message, /one-time Permit2 approval for USDC/);
  assert.equal(get('accepts[5]-amount').status, 'warn');
  assert.match(get('accepts[5]-amount').message, /18 decimals on BNB Chain; it looks written for 6-decimal USDC/);
  assert.equal(get('accepts[6]-asset').status, 'warn');
  assert.match(get('accepts[6]-asset').message, /not a dollar stablecoin x402 Doctor knows \(USDC, USDT, USD1, U\) on BNB Chain/);
});

test('checkAccepts: a non-CAIP-2 network the doctor does not know is unpayable for that reason, not as a bad EVM address', () => {
  const checks = [];
  checkAccepts([
    { scheme: 'exact', network: 'lightning:mainnet', amount: '539', payTo: '520ca7be-8ffe-4b50-ba8a-c1d8d6c2141a', asset: 'sat', extra: { merchantId: '520ca7be-8ffe-4b50-ba8a-c1d8d6c2141a' } },
    { scheme: 'exact', network: 'base', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F' },
  ], checks);
  const lightning = checks.find((c) => c.id === 'accepts[0]-payto');
  assert.equal(lightning.status, 'fail');
  assert.match(lightning.message, /no x402 client pays network "lightning:mainnet"/);
  assert.doesNotMatch(lightning.message, /EVM/);
  assert.match(lightning.hint, /lnbtc:000000000019d6689c085ae165831e93/);
  assert.equal(checks.filter((c) => c.id.startsWith('accepts[0]-asset')).length, 0, 'no asset checks for it');
  // A v1 name with an EVM payTo still gets the EVM checks.
  assert.equal(checks.find((c) => c.id === 'accepts[1]-payto').status, 'pass');
});

test('checkAccepts: amount "0" is a warning that the price depends on the request, not a failure', () => {
  const checks = [];
  checkAccepts([{ scheme: 'exact', network: 'eip155:8453', amount: '0', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F', extra: { name: 'USD Coin', version: '2' } }], checks);
  const zero = checks.find((c) => c.id === 'accepts[0]-amount-zero');
  assert.equal(zero.status, 'warn');
  assert.match(zero.message, /depends on the request/);
  assert.equal(checks.some((c) => c.id === 'accepts[0]-amount' && c.status === 'fail'), false);
});
