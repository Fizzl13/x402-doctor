// Fizzl Buy's paid MCP tool x402_buy: a real MCP client paying on Base against a mock facilitator that verifies the
// EIP-3009 signature; the purchase itself uses a local seller and a fake payFetch (nothing real is paid).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { verifyTypedData } = require('viem');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { wrapMCPClientWithPayment } = require('@x402/mcp');
const { x402Client } = require('@x402/core/client');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { ExactEvmScheme: ExactEvmServer } = require('@x402/evm/exact/server');
const { x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { createBuyApp } = require('../buy-server');
const { createBudget } = require('../lib/buy/purchase');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createSigner, verifyReceipt } = require('../lib/receipt');

const BASE = 'eip155:8453';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const SECRET = 'buy-mcp-test-secret-long-enough-0123456789';
const servers = [];
const state = { verify: 0, settle: 0 };
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
const json = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
async function body(req) { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }

let api; let paid; let gate = null; let answers = []; const logged = [];

test.before(async () => {
  const facilitator = await listen(async (req, res) => {
    if (req.url.endsWith('/supported')) return json(res, { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }], extensions: [], signers: {} });
    const { paymentPayload, paymentRequirements: reqs } = await body(req);
    const { authorization, signature } = paymentPayload.payload;
    const valid = await verifyTypedData({
      address: authorization.from,
      domain: { name: reqs.extra.name, version: reqs.extra.version, chainId: 8453, verifyingContract: reqs.asset },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      primaryType: 'TransferWithAuthorization', message: authorization, signature,
    });
    const ok = valid && authorization.to.toLowerCase() === reqs.payTo.toLowerCase() && BigInt(authorization.value) >= BigInt(reqs.amount);
    if (req.url.endsWith('/verify')) { state.verify++; return json(res, ok ? { isValid: true, payer: authorization.from } : { isValid: false, invalidReason: 'invalid_signature', payer: authorization.from }); }
    state.settle++;
    return json(res, { success: true, transaction: '0xsettled', network: BASE, payer: authorization.from });
  });
  // The seller the inkoper buys from: a 402 of $0.002 on Base for its preflight.
  const seller = await listen((req, res) => {
    const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, description: 'weather', mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: BASE, amount: '2000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    json(res, challenge);
  });
  const results = [{ url: `${seller}/w`, host: '127.0.0.1', description: 'weather forecast', method: 'GET', example: { place: 'London' }, prices: [{ network: 'Base', usd: 0.002 }], relevance: 0.95, record: { days: 30, payableDays: 30, ratio: 1 } }];
  paid = [];
  const payFetch = async (url) => {
    paid.push(url);
    if (gate) await gate;
    const a = answers.shift() ?? { status: 200, body: { temp_c: 11 } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitator })).register(BASE, new ExactEvmServer());
  await resourceServer.initialize();
  const usageLog = { middleware: (describe) => (req, res, next) => { const chunks = []; const keep = (c) => { if (c && typeof c !== 'function') chunks.push(Buffer.from(c)); }; const write = res.write.bind(res); const end = res.end.bind(res); res.write = (c, ...r) => { keep(c); return write(c, ...r); }; res.end = (c, ...r) => { keep(c); return end(c, ...r); }; res.on('finish', () => { let b; try { b = JSON.parse(Buffer.concat(chunks).toString()); } catch {} logged.push(describe(req, res, b)); }); next(); } };
  const app = createBuyApp({
    env: { AGENT_PAYOUT_WALLET: PAY_TO, PUBLIC_URL: 'https://buy.test' },
    resourceServer,
    deps: {
      fetch: async () => Response.json({ results }), safeFetch: createSafeFetch({ allowPrivate: true }), sanctions: null, trustIndex: null, lure: null,
      answerCheck: { enabled: true, check: async () => ({ delivered: { verdict: 'yes' }, injection: { flagged: false } }) },
      filler: { enabled: true, fill: async (_n, c) => ({ fits: true, request: { method: 'GET', url: `${c.url}?place=Amsterdam` } }) },
      wallet: { address: '0xBuy', payFetch, balance: async () => 5_000_000 }, budget: createBudget({ dailyUsd: 5 }),
      usageLog, signer: createSigner({ RECEIPT_SIGNER_SECRET: SECRET }, { label: 'fizzl-buy', service: 'fizzl-buy' }), instance: 'me',
    },
  });
  api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
});
test.after(() => servers.forEach((s) => s.close()));
test.beforeEach(() => { state.verify = 0; state.settle = 0; paid.length = 0; gate = null; answers = []; logged.length = 0; });

async function plainClient() { const c = new Client({ name: 'test', version: '1.0.0' }); await c.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`))); return c; }
const account = privateKeyToAccount(generatePrivateKey());
const payments = () => new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE)).register(BASE, new ExactEvmScheme(account));

test('x402_buy: listed next to the free pick; unpaid it asks $0.02 and buys nothing; bad input is refused before payment', async () => {
  const c = await plainClient();
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['x402_buy', 'x402_pick']);
  const buyTool = tools.find((t) => t.name === 'x402_buy');
  assert.match(buyTool.description, /\$0\.02/);
  assert.equal(buyTool.annotations.destructiveHint, false);
  const unpaid = await c.callTool({ name: 'x402_buy', arguments: { need: 'weather forecast for Amsterdam tomorrow' } });
  assert.ok(unpaid.isError);
  const required = unpaid.structuredContent ?? JSON.parse(unpaid.content[0].text);
  assert.deepEqual(required.accepts.map((a) => [a.network, a.amount, a.payTo]), [[BASE, '20000', PAY_TO]]);
  const bad = await c.callTool({ name: 'x402_buy', arguments: { need: 'x' } });
  assert.ok(bad.isError);
  assert.match(bad.content[0].text, /3 to 500 characters/);
  assert.deepEqual([state.verify, state.settle, paid.length], [0, 0, 0]);
  await c.close();
});

test('x402_buy: a real signed payment buys the answer, settles once, carries a receipt and logs the spend', async () => {
  const c = wrapMCPClientWithPayment(new Client({ name: 'paying-agent', version: '1.0.0' }), payments(), { autoPayment: true });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`)));
  const result = await c.callTool('x402_buy', { need: 'weather forecast for Amsterdam tomorrow' });
  assert.ok(!result.isError, JSON.stringify(result.content));
  const out = JSON.parse(result.content[0].text);
  assert.equal(out.delivered, true);
  assert.deepEqual(out.answer, { temp_c: 11 });
  assert.equal(out.paid_usd, 0.002);
  assert.equal(result.paymentMade, true);
  assert.deepEqual([state.verify, state.settle, paid.length], [1, 1, 1]);
  const signers = createSigner({ RECEIPT_SIGNER_SECRET: SECRET }, { label: 'fizzl-buy', service: 'fizzl-buy' }).signers;
  assert.equal((await verifyReceipt(out, { signers, route: 'mcp x402_buy', input: { need: 'weather forecast for Amsterdam tomorrow' }, service: 'fizzl-buy' })).valid, true);
  const entry = logged.find((e) => e && e.route === 'x402_buy' && e.payment);
  assert.deepEqual(entry.input, { chars: 39, spent_usd: 0.002, instance: 'me' });
  assert.equal(entry.result.delivered, true);
  assert.equal(entry.payment.network, 'base');
  assert.equal(entry.payment.usd, 0.02);
  await c.close();
});

test('x402_buy: no seller delivers, nothing is settled', async () => {
  answers = [{ status: 500, body: { error: 'down' } }];
  const c = wrapMCPClientWithPayment(new Client({ name: 'paying-agent', version: '1.0.0' }), payments(), { autoPayment: true });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${api}/mcp`)));
  const result = await c.callTool('x402_buy', { need: 'weather forecast for Amsterdam tomorrow' });
  assert.ok(result.isError);
  assert.match(result.content[0].text, /None of the services tried delivered/);
  assert.deepEqual([state.verify, state.settle, paid.length], [1, 0, 1]);
  await c.close();
});

test('x402_buy: one payment buys one answer, also sent twice at once', async () => {
  const c = await plainClient();
  const need = 'current bitcoin price in usd';
  const unpaid = await c.callTool({ name: 'x402_buy', arguments: { need } });
  const payload = await payments().createPaymentPayload(unpaid.structuredContent ?? JSON.parse(unpaid.content[0].text));
  let release;
  gate = new Promise((r) => { release = r; });
  const call = () => c.callTool({ name: 'x402_buy', arguments: { need }, _meta: { 'x402/payment': payload } });
  const first = call();
  while (paid.length === 0) await new Promise((r) => setTimeout(r, 5));
  const second = await call();
  assert.ok(second.isError);
  assert.match(second.content[0].text, /already in use/);
  release();
  assert.ok(!(await first).isError);
  const third = await call();
  assert.match(third.content[0].text, /already used/);
  assert.deepEqual([paid.length, state.settle], [1, 1]);
  await c.close();
});
