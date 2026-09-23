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
  const app = createApp({ allowPrivate: true, env });
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

test('discovery: OpenAPI with x-payment-info and /.well-known/x402 listing the route', async () => {
  const spec = await (await fetch(`${api}/openapi.json`)).json();
  const op = spec.paths['/api/v1/diagnose'].get;
  assert.deepEqual(op['x-payment-info'].price, { mode: 'fixed', currency: 'USD', amount: '0.01' });
  assert.ok(op.responses['402']);
  const wellKnown = await (await fetch(`${api}/.well-known/x402`)).json();
  assert.equal(wellKnown.version, 1);
  assert.deepEqual(wellKnown.resources, [`${api}/api/v1/diagnose`]);
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
  const withCdp = createPaidApi({ env: { AGENT_PAYOUT_WALLET: PAY_TO_BASE, CDP_API_KEY_ID: 'id', CDP_API_KEY_SECRET: 'c2VjcmV0' } });
  assert.equal(withCdp.paymentInfo.facilitator, 'cdp, payai fallback');
});

test('free web API still works and the paid route is off without payout wallets', async () => {
  const app = createApp({ allowPrivate: true, env: {} });
  const base = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  assert.equal((await fetch(diagnoseUrl(targetUrl).replace(api, base))).status, 503);
  const free = await fetch(`${base}/api/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: targetUrl }) });
  assert.equal(free.status, 200);
  assert.deepEqual((await (await fetch(`${base}/.well-known/x402`)).json()).resources, []);
});
