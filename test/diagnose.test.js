// Integration tests: the doctor against local fixture servers. "healthy" is
// shaped like a correct @x402/express v2 service (Base + Solana, Bazaar,
// OpenAPI, mainnet paywall); "broken" reproduces real bugs we hit.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { diagnose, checkResource, checkAccepts, checkOpenApi } = require('../lib/diagnose');
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
