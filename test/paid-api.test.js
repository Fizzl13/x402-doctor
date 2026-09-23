// Paid agent API (GET /api/v1/diagnose) against a mock PayAI facilitator that
// really verifies the EIP-3009 signature, paid by a real x402 client.

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

  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, AGENT_PAYOUT_WALLET_SOLANA: PAY_TO_SOLANA, FACILITATOR_URL: facilitatorUrl };
  const trustIndex = {
    lookup: async (u) => (u.startsWith(targetUrl) ? { days_checked: 5, days_payable: 1, payable_ratio: 0.2, history: 'nnngn', last: 'n', streak: 1 } : null),
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
  assert.equal(header.extensions.bazaar.info.input.queryParams.url, 'https://ichimoku-signal.onrender.com/signal/BTC-USDT');

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

test('discovery: OpenAPI with x-payment-info and /.well-known/x402 listing the route', async () => {
  const spec = await (await fetch(`${api}/openapi.json`)).json();
  const op = spec.paths['/api/v1/diagnose'].get;
  assert.deepEqual(op['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.01' });
  assert.ok(op.responses['402']);
  const wellKnown = await (await fetch(`${api}/.well-known/x402`)).json();
  assert.equal(wellKnown.version, 1);
  assert.deepEqual(wellKnown.resources, [`${api}/api/v1/diagnose`, `${api}/api/v1/preflight`]);
  const preflightOp = spec.paths['/api/v1/preflight'].get;
  assert.deepEqual(preflightOp['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.001' });
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
  assert.equal(withCdp.paymentInfo.facilitator, 'cdp, payai fallback');
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
  const media = createMediaCache({ base: 'https://raw.test/branch', dir, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }) });
  const app = createApp({ allowPrivate: true, env: {}, trustIndex: { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null }, media });
  const base = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const first = await fetch(`${base}/media/explainer.mp4`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), 'https://raw.test/branch/x402-doctor-explainer.mp4');
  await media.warm();
  const ranged = await fetch(`${base}/media/explainer.mp4`, { headers: { range: 'bytes=2-5' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-type'), 'video/mp4');
  assert.equal(await ranged.text(), '2345');
  assert.equal((await fetch(`${base}/media/other.mp4`)).status, 404);
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /<video[^>]+poster="\/media\/explainer.jpg"/);
});
