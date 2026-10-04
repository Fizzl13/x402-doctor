// Paid agent API (GET /api/v1/diagnose) against a mock PayAI facilitator that
// really verifies the EIP-3009 signature, paid by a real x402 client.

// No real Base RPC in tests: the payout-wallet lookup fails fast and is skipped.
process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { verifyTypedData } = require('viem');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { createApp } = require('../server');

const BASE = 'eip155:8453';
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const PAY_TO_SOLANA = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';

const servers = [];
const state = { verify: 0, settle: 0 };
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
const json = (res, value) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};

let facilitatorUrl;
let targetUrl;
let api;

test.before(async () => {
  facilitatorUrl = await listen(async (req, res) => {
    if (req.url.endsWith('/supported')) {
      return json(res, {
        kinds: [
          { x402Version: 2, scheme: 'exact', network: BASE },
          { x402Version: 2, scheme: 'exact', network: SOLANA, extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } },
        ],
        extensions: [],
        signers: {},
      });
    }
    const { paymentPayload, paymentRequirements: reqs } = await body(req);
    const { authorization, signature } = paymentPayload.payload;
    const valid = await verifyTypedData({
      address: authorization.from,
      domain: { name: reqs.extra.name, version: reqs.extra.version, chainId: 8453, verifyingContract: reqs.asset },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: authorization,
      signature,
    });
    const ok = valid && authorization.to === reqs.payTo && BigInt(authorization.value) >= BigInt(reqs.amount);
    if (req.url.endsWith('/verify')) {
      state.verify++;
      return json(res, ok ? { isValid: true, payer: authorization.from } : { isValid: false, invalidReason: 'invalid_signature', payer: authorization.from });
    }
    state.settle++;
    return json(res, { success: true, transaction: '0xsettled', network: BASE, payer: authorization.from });
  });

  // The endpoint being diagnosed: a minimal x402 v2 service.
  targetUrl = await listen((_req, res) => {
    const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO_BASE, maxTimeoutSeconds: 60 }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    json(res, challenge);
  });

  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, AGENT_PAYOUT_WALLET_SOLANA: PAY_TO_SOLANA, FACILITATOR_URL: facilitatorUrl, RECEIPT_SIGNER_SECRET: 'paid-api-test-secret-long-enough-0123456789', MPP_SECRET: 'paid-api-mpp-secret-0123456789' };
  const trustIndex = {
    lookup: async (u) => (u.startsWith(targetUrl) ? { days_checked: 5, days_payable: 1, payable_ratio: 0.2, history: 'nnngn', last: 'n', streak: 1 } : null),
    seller: async (u) => (u.startsWith(targetUrl) ? { origin: new URL(targetUrl).origin, resources: 4, payable_now: 1, avg_payable_ratio: 0.25, unreliable: 3 } : null),
    refresh: () => Promise.resolve(),
    summary: () => ({ updated: '2026-09-23T03:00:00Z', days: 5, resources: 1, latest: { go: 0, caution: 0, no_go: 1, unreachable: 0 } }),
  };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, trustIndex });
  api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
});

test.after(() => servers.forEach((s) => s.close()));
test.beforeEach(() => {
  state.verify = 0;
  state.settle = 0;
});

const diagnoseUrl = (target, extra = '') => `${api}/api/v1/diagnose?url=${encodeURIComponent(target)}${extra}`;

test('unpaid request: 402 offering $0.01 USDC on Base and Solana, mirrored into the body', async () => {
  const res = await fetch(diagnoseUrl(targetUrl));
  assert.equal(res.status, 402);
  assert.ok(res.headers.get('payment-required'));
  const challenge = await res.json();
  assert.deepEqual(challenge.accepts.map((a) => a.network).sort(), [BASE, SOLANA].sort());
  for (const a of challenge.accepts) assert.equal(a.amount, '10000');
  assert.equal(challenge.accepts.find((a) => a.network === SOLANA).payTo, PAY_TO_SOLANA);
  assert.equal(state.verify, 0);
});

test('called on the Render address, the challenge (and so the Bazaar listing) names x402-doctor.fizzl.eu', async () => {
  const { port } = new URL(api);
  const headers = await new Promise((resolve, reject) => {
    require('node:http').get({ host: '127.0.0.1', port, path: '/api/v1/diagnose', headers: { host: 'x402-doctor.onrender.com' } }, (res) => { res.resume(); resolve(res.headers); }).on('error', reject);
  });
  const header = JSON.parse(Buffer.from(headers['payment-required'], 'base64').toString('utf8'));
  assert.equal(header.resource.url, 'https://x402-doctor.fizzl.eu/api/v1/diagnose');
});

test('bare route (no url) answers 402 so indexers like x402scan can register it', async () => {
  const res = await fetch(`${api}/api/v1/diagnose`);
  assert.equal(res.status, 402);
});

test('invalid input is rejected before payment', async () => {
  for (const url of [`${api}/api/v1/diagnose?url=not-a-url`, `${api}/api/v1/diagnose?url=ftp%3A%2F%2Fx.y`, diagnoseUrl(targetUrl, '&method=PUT')]) {
    const res = await fetch(url);
    assert.equal(res.status, 400, url);
    assert.equal(res.headers.get('payment-required'), null, url);
  }
});

test('paid request: a real signed Base payment returns the diagnosis and is settled once', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_version, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const paidFetch = wrapFetchWithPayment(fetch, client);

  const res = await paidFetch(diagnoseUrl(targetUrl));
  const report = await res.json();
  assert.equal(res.status, 200, JSON.stringify(report));
  assert.equal(report.url, new URL(targetUrl).href);
  assert.ok(report.checks.some((c) => c.id === 'returns-402' && c.status === 'pass'));
  assert.equal(state.verify, 1);
  assert.equal(state.settle, 1);
});

test('paid request without url: 400 and nothing is settled', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_version, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const res = await wrapFetchWithPayment(fetch, client)(`${api}/api/v1/diagnose`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /url is required/);
  assert.equal(state.settle, 0);
});

test('preflight: unpaid 402 at $0.001; a paid call returns the verdict (no_go: the target lacks the EIP-712 domain)', async () => {
  const unpaid = await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent(targetUrl)}`);
  assert.equal(unpaid.status, 402);
  const challenge = await unpaid.json();
  for (const a of challenge.accepts) assert.equal(a.amount, '1000');
  const header = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64').toString('utf8'));
  assert.equal(header.extensions.bazaar.info.input.queryParams.url, 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT');
  // The body mirrors the whole v2 challenge, resource included (x402-trust.com flags a v2 body without it).
  assert.deepEqual(challenge.resource, header.resource);
  assert.match(challenge.resource.url, /\/api\/v1\/preflight/);

  assert.equal((await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent(targetUrl)}&max_usd=abc`)).status, 400);
  assert.equal((await fetch(`${api}/api/v1/preflight?url=${encodeURIComponent(targetUrl)}&network=base`)).status, 400);

  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_version, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const res = await wrapFetchWithPayment(fetch, client)(`${api}/api/v1/preflight?url=${encodeURIComponent(targetUrl)}&max_usd=0.05`);
  const report = await res.json();
  assert.equal(res.status, 200, JSON.stringify(report));
  // The fixture seller omits extra.name/version, so a Base payment to it could not be signed.
  assert.equal(report.verdict, 'no_go', JSON.stringify(report.reasons));
  assert.equal(report.options[0].usd, 0.01);
  assert.match(report.options[0].problems.join(' '), /EIP-712 domain/);
  // Track record from the trust index: payable on 1 of 5 days -> caution reason and signal.
  assert.ok(report.reasons.some((r) => r.code === 'unreliable_history' && /1 of the last 5/.test(r.message)));
  assert.equal(report.signals.track_record.history, 'nnngn');
  assert.equal(state.settle, 1);

  // Signed verdict: the published signer signed it, bound to this url and budget; flipping it breaks it.
  const signer = await (await fetch(`${api}/.well-known/x402-doctor-signer.json`)).json();
  assert.equal(signer.signing, true);
  assert.equal(report.receipt.signer, signer.signers[0].address);
  assert.equal(report.receipt.route, 'GET /api/v1/preflight');
  const verify = (body) => fetch(`${api}/api/v1/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const ok = await verify({ response: report, route: 'GET /api/v1/preflight', input: { url: targetUrl, max_usd: '0.05' } });
  assert.deepEqual([ok.valid, ok.known_signer, ok.input_matches], [true, true, true], JSON.stringify(ok));
  assert.equal(report.receipt.payment.payer, account.address, 'HTTP receipts name the payer too');
  assert.equal(report.receipt.payment.proof, 'eip3009');
  const flipped = await verify({ response: { ...report, verdict: 'go' } });
  assert.equal(flipped.valid, false);
});

test('fix: unpaid 402 at $0.05; a paid call returns the code fix for the missing EIP-712 domain; bad stack is 400 before payment', async () => {
  const unpaid = await fetch(`${api}/api/v1/fix?url=${encodeURIComponent(targetUrl)}`);
  assert.equal(unpaid.status, 402);
  for (const a of (await unpaid.json()).accepts) assert.equal(a.amount, '50000');
  assert.equal((await fetch(`${api}/api/v1/fix?url=${encodeURIComponent(targetUrl)}&stack=cobol`)).status, 400);

  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_version, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const res = await wrapFetchWithPayment(fetch, client)(`${api}/api/v1/fix?url=${encodeURIComponent(targetUrl)}&stack=generic`);
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.stack.id, 'generic');
  const fix = out.fixes.find((f) => f.recipe === 'eip712');
  assert.ok(fix, JSON.stringify(out.fixes.map((f) => f.recipe)));
  assert.equal(fix.severity, 'fail');
  assert.match(fix.code.map((c) => c.snippet).join('\n'), /"name":"USD Coin","version":"2"/);
  assert.ok(out.fixes.every((f) => f.code.every((c) => c.stack !== 'node' && c.stack !== 'express')), 'generic stack gets no Node snippets');
  assert.equal(state.settle, 1);
});

test('free trust lookup: track record for a scanned URL, 404 for an unknown one, 400 without url, summary', async () => {
  const known = await fetch(`${api}/api/trust?url=${encodeURIComponent(targetUrl)}`);
  assert.equal(known.status, 200);
  assert.equal((await known.json()).payable_ratio, 0.2);
  const unknown = await fetch(`${api}/api/trust?url=${encodeURIComponent('https://nobody.example/x')}`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).index.resources, 1);
  assert.equal((await fetch(`${api}/api/trust`)).status, 400);
  assert.equal((await (await fetch(`${api}/api/trust/summary`)).json()).latest.no_go, 1);
});

test('Bazaar curation metadata: serviceName, category, iconUrl and tags in /.well-known/x402 and in the 402 challenge; the icon is served', async () => {
  const w = await (await fetch(`${api}/.well-known/x402`)).json();
  assert.equal(w.serviceName, 'x402 Doctor');
  assert.equal(w.category, 'developer-tools');
  assert.match(w.iconUrl, /\/icon\.png$/);
  assert.ok(w.tags.length > 0);
  const icon = await fetch(`${api}/icon.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  for (const route of ['/api/v1/diagnose', '/api/v1/preflight', '/api/v1/fix', '/api/v1/preflight/batch', '/api/v1/preflight/deep']) {
    const res = await fetch(`${api}${route}`);
    assert.equal(res.status, 402, route);
    const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
    assert.equal(challenge.resource.serviceName, 'x402 Doctor', route);
    assert.equal(challenge.resource.iconUrl, 'https://x402-doctor.fizzl.eu/icon.png', route);
    assert.ok(challenge.resource.tags.length > 0, route);
  }
});

test('discovery: OpenAPI with x-payment-info and /.well-known/x402 listing the route', async () => {
  const spec = await (await fetch(`${api}/openapi.json`)).json();
  for (const p of ['/api/v1/diagnose', '/api/v1/preflight', '/api/v1/fix']) {
    assert.equal(spec.paths[p].get.responses[200].content['application/json'].schema.properties.receipt.properties.algorithm.enum[0], 'eip191-canonical-json-v1', p);
  }
  assert.match(spec.info['x-guidance'], /signed receipt/);
  assert.match((await (await fetch(`${api}/.well-known/x402`)).json()).signer, /\/\.well-known\/x402-doctor-signer\.json$/);
  const agent = await (await fetch(`${api}/.well-known/agent-registration.json`)).json();
  assert.equal(agent.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  assert.deepEqual(agent.services.map((x) => [x.name, x.endpoint]), [['web', 'https://x402-doctor.fizzl.eu/'], ['MCP', 'https://x402-doctor.fizzl.eu/mcp']], 'always the public address');
  assert.strictEqual(agent.x402Support, true);
  assert.deepStrictEqual(agent.registrations, [{ agentId: 'CLgJCXbmpJeL4v8KeXb6UGLHcVG4AkNDXKBWQjm1dupj', agentRegistry: 'solana:101:metaplex' }, { agentId: 97519, agentRegistry: 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }]);
  const signerDoc = await (await fetch(`${api}/.well-known/x402-doctor-signer.json`)).json();
  assert.equal(signerDoc.authority, '0x6B0F4651eD42893ab58139938175E4a69f175F25', 'the payout wallet authorises keys');
  assert.equal(signerDoc.certificate, null, 'no certificate configured in tests');
  const page = await (await fetch(`${api}/sign-receipt-key`)).text();
  assert.match(page, /service: \$\{SERVICE\}/);
  assert.match(page, /const SERVICE = "x402-doctor"/);
  assert.doesNotMatch(page, /\{\{/, 'all placeholders filled');
  const op = spec.paths['/api/v1/diagnose'].get;
  assert.deepEqual(op['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.01' });
  assert.ok(op.responses['402']);
  const wellKnown = await (await fetch(`${api}/.well-known/x402`)).json();
  assert.equal(wellKnown.version, 1);
  const ROUTES = ['/api/v1/diagnose', '/api/v1/preflight', '/api/v1/preflight/batch', '/api/v1/preflight/deep', '/api/v1/fix'];
  assert.deepEqual(wellKnown.resources, ROUTES.map((r) => `${api}${r}`));
  // fetch cannot set Host; behind the trusted proxy X-Forwarded-Host sets req.hostname the same way.
  const onRender = await (await fetch(`${api}/.well-known/x402`, { headers: { 'x-forwarded-host': 'x402-doctor.onrender.com' } })).json();
  assert.deepEqual(onRender.resources, ROUTES.map((r) => `https://x402-doctor.fizzl.eu${r}`));
  assert.equal(onRender.signer, 'https://x402-doctor.fizzl.eu/.well-known/x402-doctor-signer.json');
  assert.deepEqual(spec.paths['/api/v1/fix'].get['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.05' });
  const preflightOp = spec.paths['/api/v1/preflight'].get;
  assert.deepEqual(preflightOp['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.001' });
  assert.deepEqual(spec.paths['/api/v1/preflight/batch'].get['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.005' });
  assert.equal(spec.paths['/api/v1/preflight/batch'].get.parameters[0].schema.maxItems, 10);
  assert.deepEqual(spec.paths['/api/v1/preflight/deep'].get['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.01' });
  assert.ok(spec.paths['/api/v1/preflight/deep'].get.responses[200].content['application/json'].schema.properties.seller);
});

test('browsers get a wallet paywall (mainnet, Base first) instead of the bare 402', async () => {
  const res = await fetch(diagnoseUrl(targetUrl), { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' } });
  assert.equal(res.status, 402);
  const html = await res.text();
  assert.match(html, /window\.x402/);
  assert.match(html, /eip155:8453/);
  assert.doesNotMatch(html, /"testnet":\s*true/);
});

test('health reports the facilitator: PayAI by default, CDP first when CDP keys are set', async () => {
  const health = await (await fetch(`${api}/api/health`)).json();
  assert.equal(health.paid.facilitator, 'payai');
  const { createPaidApi } = require('../lib/paid-api');
  const withCdp = createPaidApi({ env: { AGENT_PAYOUT_WALLET: PAY_TO_BASE, CDP_API_KEY_ID: 'id', CDP_API_KEY_SECRET: 'c2VjcmV0', DOCTOR_WARM_BAZAAR_INDEX: '0' } });
  assert.equal(withCdp.paymentInfo.facilitator, 'cdp for base, payai for solana');
  const cdpOnly = createPaidApi({ env: { AGENT_PAYOUT_WALLET: PAY_TO_BASE, CDP_API_KEY_ID: 'id', CDP_API_KEY_SECRET: 'c2VjcmV0', DOCTOR_SOLANA_FACILITATOR: 'cdp', DOCTOR_WARM_BAZAAR_INDEX: '0' } });
  assert.equal(cdpOnly.paymentInfo.facilitator, 'cdp, payai fallback');
});

test('onlyNetworks: PayAI claims Solana only, verify and settle pass through', async () => {
  const { onlyNetworks } = require('../lib/paid-api');
  const calls = [];
  const client = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', extra: { feePayer: 'F' } }], signers: {} }),
    verify: async (p, r) => { calls.push(['verify', p, r]); return { isValid: true }; },
    settle: async (p, r) => { calls.push(['settle', p, r]); return { success: true }; },
  };
  const solanaOnly = onlyNetworks(client, (n) => n.startsWith('solana:'));
  const supported = await solanaOnly.getSupported();
  assert.deepEqual(supported.kinds.map((k) => k.network), ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
  assert.equal(supported.kinds[0].extra.feePayer, 'F');
  assert.deepEqual(supported.signers, {});
  assert.deepEqual(await solanaOnly.verify('p', 'r'), { isValid: true });
  assert.deepEqual(await solanaOnly.settle('p', 'r'), { success: true });
  assert.deepEqual(calls, [['verify', 'p', 'r'], ['settle', 'p', 'r']]);
});

test('free web API still works and the paid route is off without payout wallets', async () => {
  const app = createApp({ allowPrivate: true, env: {}, trustIndex: { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null } });
  const base = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  assert.equal((await fetch(diagnoseUrl(targetUrl).replace(api, base))).status, 503);
  const free = await fetch(`${base}/api/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: targetUrl }) });
  assert.equal(free.status, 200);
  const report = await free.json();
  assert.equal(report.share_url, `${base}/?url=${encodeURIComponent(targetUrl)}`, 'a link that re-runs the check in the browser');
  const withMethod = await (await fetch(`${base}/api/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: targetUrl, method: 'GET' }) })).json();
  assert.equal(new URL(withMethod.share_url).searchParams.get('method'), 'GET');
  assert.deepEqual((await (await fetch(`${base}/.well-known/x402`)).json()).resources, []);
});

test('/demo/broken: always 402, broken on purpose (decimal amount, missing Solana fee payer), never settles', async () => {
  const { diagnose } = require('../lib/diagnose');
  const { createSafeFetch } = require('../lib/safe-fetch');
  const withPayment = await fetch(`${api}/demo/broken`, { headers: { 'PAYMENT-SIGNATURE': 'eyJ4IjoxfQ==' } });
  assert.equal(withPayment.status, 402, 'a payment header changes nothing');
  assert.equal(state.verify, 0);
  const report = await diagnose(`${api}/demo/broken`, { safeFetch: createSafeFetch({ allowPrivate: true }), rpcUrl: 'http://127.0.0.1:1' });
  assert.equal(report.overall, 'fail');
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(byId['accepts[0]-amount'].status, 'warn');
  assert.match(byId['accepts[0]-amount'].hint, /smallest unit/);
  assert.equal(byId['accepts[1]-extra'].status, 'fail');
  assert.match(byId['accepts[1]-extra'].message, /feePayer/);
  assert.equal(byId['resource-url'].status, 'pass');
});

test('/media: redirects to GitHub until the file is cached, then serves it with byte ranges', async () => {
  const { createMediaCache } = require('../lib/media');
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  const body = Buffer.from('0123456789');
  const media = createMediaCache({ base: 'https://raw.test/branch', fixBase: 'https://raw.test/fix-branch', dir, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }) });
  const app = createApp({ allowPrivate: true, env: {}, trustIndex: { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null }, media });
  const base = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const first = await fetch(`${base}/media/explainer.mp4`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), 'https://raw.test/branch/x402-doctor-explainer.mp4');
  const fixFirst = await fetch(`${base}/media/fix.mp4`, { redirect: 'manual' });
  assert.equal(fixFirst.headers.get('location'), 'https://raw.test/fix-branch/x402-doctor-fix.mp4');
  await media.warm();
  const ranged = await fetch(`${base}/media/explainer.mp4`, { headers: { range: 'bytes=2-5' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-type'), 'video/mp4');
  assert.equal(await ranged.text(), '2345');
  assert.equal((await fetch(`${base}/media/other.mp4`)).status, 404);
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /<video[^>]+poster="\/media\/explainer.jpg"/);
  assert.doesNotMatch(home, /\/media\/fix\./, "one video on the homepage; fix.mp4 stays served for links shared earlier");
  const fixRanged = await fetch(`${base}/media/fix.mp4`, { headers: { range: 'bytes=0-1' } });
  assert.equal(fixRanged.status, 206);
});

const payingFetch = () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_version, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  return wrapFetchWithPayment(fetch, client);
};

test('preflight batch: $0.005 for up to 10 endpoints; input checked before payment; one verdict per endpoint plus totals', async () => {
  const q = (urls, extra = '') => `${api}/api/v1/preflight/batch?${urls.map((u) => `url=${encodeURIComponent(u)}`).join('&')}${extra}`;
  const unpaid = await fetch(q([targetUrl, `${targetUrl}/other`]));
  assert.equal(unpaid.status, 402);
  for (const a of (await unpaid.json()).accepts) assert.equal(a.amount, '5000');
  assert.equal((await fetch(`${api}/api/v1/preflight/batch`)).status, 402, 'bare route: indexers get the challenge');
  assert.equal((await fetch(`${api}/api/v1/preflight/batch?url=&max_usd=0.05`)).status, 402, 'a blank url (probers fill empty examples) counts as no url');
  assert.equal((await fetch(`${api}/api/v1/preflight?url=`)).status, 402, 'same for the single preflight');

  const eleven = Array.from({ length: 11 }, (_, i) => `https://example.com/paid/${i}`);
  for (const bad of [q(eleven), q([targetUrl, 'not-a-url']), q([targetUrl, 'ftp://x.y']), q([targetUrl], '&max_usd=abc')]) {
    const res = await fetch(bad);
    assert.equal(res.status, 400, bad);
    assert.equal(res.headers.get('payment-required'), null, bad);
  }

  // The same url twice counts once; the unreachable one is "no_go" (no 402), not an error for the rest.
  const res = await payingFetch()(q([targetUrl, targetUrl, 'http://127.0.0.1:1/paid'], '&max_usd=0.05'));
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.count, 2);
  assert.equal(out.results[0].url, targetUrl);
  assert.equal(out.results[0].verdict, 'no_go');
  assert.equal(out.results[0].track_record.payable_ratio, 0.2);
  assert.ok(['no_go', 'unknown'].includes(out.results[1].verdict));
  assert.equal(Object.values(out.counts).reduce((a, b) => a + b, 0), 2);
  assert.equal(out.receipt.route, 'GET /api/v1/preflight/batch');
  assert.equal(state.settle, 1);
});

test('preflight deep: $0.01; the preflight plus the full diagnosis, daily history, seller and domain checks', async () => {
  const unpaid = await fetch(`${api}/api/v1/preflight/deep?url=${encodeURIComponent(targetUrl)}`);
  assert.equal(unpaid.status, 402);
  for (const a of (await unpaid.json()).accepts) assert.equal(a.amount, '10000');
  const two = await fetch(`${api}/api/v1/preflight/deep?url=${encodeURIComponent(targetUrl)}&url=${encodeURIComponent(targetUrl)}`);
  assert.equal(two.status, 400, 'one url; several go to the batch route');

  const res = await payingFetch()(`${api}/api/v1/preflight/deep?url=${encodeURIComponent(targetUrl)}&max_usd=0.05`);
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.verdict, 'no_go');
  assert.ok(out.diagnosis.checks.length > 5);
  assert.ok(out.diagnosis.problems.every((c) => c.status === 'fail' || c.status === 'warn'));
  assert.deepEqual(out.history.map((d) => d.status), ['no_go', 'no_go', 'no_go', 'go', 'no_go']);
  assert.equal(out.seller.resources, 4);
  assert.ok(out.reasons.some((r) => r.code === 'unreliable_seller' && /25%/.test(r.message)));
  assert.ok(Array.isArray(out.domain.checks));
  assert.equal(out.receipt.route, 'GET /api/v1/preflight/deep');
  assert.equal(state.settle, 1);
});

test('MPP: the 402 also carries an MPP evm challenge; a signed MPP credential is verified, served and settled once', async () => {
  const { keccak256, stringToHex } = require('viem');
  const { parseChallenges } = require('../lib/mpp');
  const unpaid = await fetch(diagnoseUrl(targetUrl));
  assert.equal(unpaid.status, 402);
  assert.ok(unpaid.headers.get('payment-required'), 'x402 challenge still there');
  const [{ params, request }] = parseChallenges(unpaid.headers.get('www-authenticate'));
  assert.equal(params.method, 'evm');
  assert.equal(params.realm, 'x402-doctor.fizzl.eu');
  assert.equal(request.amount, '10000');
  assert.equal(request.recipient, PAY_TO_BASE);

  const account = privateKeyToAccount(generatePrivateKey());
  const nonce = keccak256(stringToHex(JSON.stringify([params.id, params.realm])));
  const validBefore = String(Math.floor(Date.parse(params.expires) / 1000));
  const message = { from: account.address, to: request.recipient, value: BigInt(request.amount), validAfter: 0n, validBefore: BigInt(validBefore), nonce };
  const signature = await account.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: request.currency },
    types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'TransferWithAuthorization',
    message,
  });
  const credential = { challenge: params, payload: { type: 'authorization', from: account.address, to: request.recipient, value: request.amount, validAfter: '0', validBefore, nonce, signature } };
  const res = await fetch(diagnoseUrl(targetUrl), { headers: { authorization: `Payment ${Buffer.from(JSON.stringify(credential)).toString('base64url')}` } });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).checks);
  assert.equal(state.verify, 1);
  assert.equal(state.settle, 1);
  const receipt = JSON.parse(Buffer.from(res.headers.get('payment-receipt'), 'base64url').toString());
  assert.deepEqual([receipt.method, receipt.reference, receipt.status], ['evm', '0xsettled', 'success']);
});
