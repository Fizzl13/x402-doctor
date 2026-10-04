// Integration tests: the doctor against local fixture servers. "healthy" is
// shaped like a correct @x402/express v2 service (Base + Solana, Bazaar,
// OpenAPI, mainnet paywall); "broken" reproduces real bugs we hit.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { diagnose, checkResource, checkAccepts, checkOpenApi, checkWellKnown, checkBazaarListing, checkPaywall } = require('../lib/diagnose');
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

test('multi-chain options: XRPL and Arbitrum are judged by their own rules, unknown chains are not failed', () => {
  const checks = [];
  checkAccepts([
    // Shaped like a real XRPL option (RLUSD, decimal amount, r-address, issuer).
    { scheme: 'exact', network: 'xrpl:0', amount: '0.01', asset: '524C555344000000000000000000000000000000', payTo: 'rKv7LTd19CUsKKirVzdZWK4HuFChHf4Hp7', maxTimeoutSeconds: 300, extra: { issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' } },
    { scheme: 'exact', network: 'eip155:42161', amount: '10000', asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', payTo: '0x408C4610F6879a75c25722cfCd18A2Eff99dc20F', extra: { name: 'USD Coin', version: '2' } },
    { scheme: 'exact', network: 'stellar:pubnet', amount: '0.01', asset: 'USDC', payTo: 'GABC' },
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

test('an openapi.json cut off at the size cap is reported as too large, not as invalid JSON', async () => {
  const checks = [];
  const fetchCapped = async () => ({ status: 200, text: '{"openapi":"3.1.0","paths":{"/a":', truncated: true });
  await checkOpenApi('https://api.example.com', fetchCapped, checks);
  const c = checks.find((x) => x.id === 'openapi-present');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /too large/);
  assert.doesNotMatch(c.message, /not valid JSON/);
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
