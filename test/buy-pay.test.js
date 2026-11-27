// Fizzl Pay (lib/buy/pay-url.js, POST /v1/pay on Fizzl Buy): pay an x402 endpoint on Base with another chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PayError, feeFor, urlShape, targetOf, createQuotes, quoteFor, payUrl } = require('../lib/buy/pay-url');
const { createBudget } = require('../lib/buy/purchase');
const { createBuyApp, routesFor } = require('../buy-server');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SELLER = '0x2222222222222222222222222222222222222222';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const ICHIMOKU_PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';

// A seller that answers 402 with USDC on Base at `amount` (6 decimals), as a fetch for the preflight.
function sellerFetch(state) {
  return async (url) => {
    state.asked = (state.asked || 0) + 1;
    // Ichimoku (the bare /v1/pay's example endpoint) answers with its real payout, as live: Doctor's payee history
    // knows it, and a mock address there reads as payto_changed.
    const payTo = String(url).startsWith('https://ichimoku-signal.fizzl.eu/') ? ICHIMOKU_PAY_TO : SELLER;
    const accepts = [{ scheme: 'exact', network: state.network || 'eip155:8453', amount: String(state.amount), asset: USDC, payTo, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }];
    const challenge = { x402Version: 2, resource: { url: String(url), description: 'weather', mimeType: 'application/json' }, accepts };
    return new Response(JSON.stringify(challenge), { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') } });
  };
}

test('pay: the fee is 2%, at least $0.002, rounded up to a millionth', () => {
  assert.equal(feeFor(0.001), 0.002);
  assert.equal(feeFor(0.01), 0.002);
  assert.equal(feeFor(0.5), 0.01);
  assert.equal(feeFor(0.123457), 0.002470);
});

test('pay: the endpoint named must be https, without credentials, GET or POST, and not Fizzl Pay itself', () => {
  assert.deepEqual(targetOf({ url: 'https://a.test/w?place=Amsterdam#x' }), { url: 'https://a.test/w?place=Amsterdam', method: 'GET' });
  assert.deepEqual(targetOf({ url: 'https://a.test/w', method: 'post' }), { url: 'https://a.test/w', method: 'POST' });
  for (const [q, re] of [[{}, /url:/], [{ url: 'http://a.test/w' }, /only https/], [{ url: 'https://u:p@a.test/' }, /credentials/], [{ url: 'https://a.test', method: 'PUT' }, /GET or POST/], [{ url: 'https://buy.fizzl.eu/v1/buy' }, /does not pay itself/], [{ url: 'not a url' }, /not a valid/]]) {
    assert.throws(() => targetOf(q), (e) => e instanceof PayError && e.status === 400 && re.test(e.message));
  }
});

test('pay: forgiving where the meaning is plain (a bare host, a URL encoded twice); the log gets only the shape', () => {
  assert.deepEqual(targetOf({ url: 'example.com/weather?place=Amsterdam' }), { url: 'https://example.com/weather?place=Amsterdam', method: 'GET' });
  assert.deepEqual(targetOf({ url: 'https%3A%2F%2Fexample.com%2Fweather' }), { url: 'https://example.com/weather', method: 'GET' });
  assert.throws(() => targetOf({ url: 'https://weather/now' }), (e) => e.status === 400 && /not a host name/.test(e.message));
  assert.throws(() => targetOf({ url: ['https://a.test', 'https://b.test'] }), (e) => e.status === 400 && /one endpoint/.test(e.message));
  assert.throws(() => targetOf({ url: 'not a url' }), (e) => e.status === 400 && /URL-encoded, e\.g\./.test(e.message));
  assert.deepEqual(['', 'https://a.test/x', 'http://a.test', 'a.test/x', 'https%3A%2F%2Fa.test', 'ftp://a.test', 'not a url', ['a', 'b']].map(urlShape), ['missing', 'https', 'http', 'no scheme', 'encoded twice', 'other scheme', 'other', 'repeated']);
});

test('pay: quotes last ten minutes', () => {
  let t = 0;
  const q = createQuotes({ now: () => t });
  q.set({ url: 'https://a.test/w', method: 'GET', total_usd: 0.012 });
  assert.equal(q.get('GET', 'https://a.test/w').total_usd, 0.012);
  assert.equal(q.get('POST', 'https://a.test/w'), null);
  t = 11 * 60 * 1000;
  assert.equal(q.get('GET', 'https://a.test/w'), null);
});

test('pay: the quote is the seller\'s price on Base plus the fee; over the cap, or not on Base, nothing is quoted', async () => {
  const state = { amount: 10000 };
  const deps = { safeFetch: sellerFetch(state), capUsd: 1 };
  const q = await quoteFor({ url: 'https://seller.test/w', method: 'GET' }, deps);
  assert.deepEqual(q, { url: 'https://seller.test/w', method: 'GET', seller_usd: 0.01, fee_usd: 0.002, total_usd: 0.012, pay_to: SELLER });
  state.amount = 2_000_000;
  await assert.rejects(quoteFor({ url: 'https://seller.test/w', method: 'GET' }, deps), (e) => e.status === 422);
  state.amount = 10000; state.network = 'eip155:137';
  await assert.rejects(quoteFor({ url: 'https://seller.test/w', method: 'GET' }, deps), (e) => e.status === 422);
});

test('pay: the seller is paid on Base and its answer returned; no delivery, a higher price or no budget charges nothing', async () => {
  const state = { amount: 10000 };
  const paid = [];
  const answers = [];
  const payFetch = async (url, init) => { paid.push({ url, method: init.method, body: init.body }); const a = answers.shift() ?? { status: 200, body: '{"temp_c":11}' }; return new Response(a.body, { status: a.status, headers: { 'content-type': 'application/json' } }); };
  const budget = createBudget({ dailyUsd: 5 });
  const deps = { safeFetch: sellerFetch(state), capUsd: 1, payFetch, balance: async () => 5_000_000, budget };
  const quote = await quoteFor({ url: 'https://seller.test/w', method: 'POST', body: '{"place":"Amsterdam"}' }, deps);
  const out = await payUrl(quote, { body: '{"place":"Amsterdam"}' }, deps);
  assert.equal(out.delivered, true);
  assert.deepEqual(out.answer, { temp_c: 11 });
  assert.deepEqual(out.paid, { seller_usd: 0.01, fee_usd: 0.002, total_usd: 0.012, seller_network: 'eip155:8453' });
  assert.deepEqual(paid[0], { url: 'https://seller.test/w', method: 'POST', body: '{"place":"Amsterdam"}' });
  assert.equal(budget.spent(), 0.01);

  answers.push({ status: 500, body: 'oops' });
  await assert.rejects(payUrl(quote, { body: '{}' }, deps), (e) => e.status === 502 && e.spent === 0.01 && /did not deliver/.test(e.message));

  state.amount = 20000;
  await assert.rejects(payUrl(quote, {}, deps), (e) => e.status === 409 && e.spent === 0 && /now asks \$0\.02/.test(e.message));
  state.amount = 10000;
  await assert.rejects(payUrl(quote, {}, { ...deps, budget: createBudget({ dailyUsd: 0.005 }) }), (e) => e.status === 503 && e.spent === 0);
  await assert.rejects(payUrl(quote, {}, { ...deps, balance: async () => 5 }), (e) => e.status === 503 && /empty/.test(e.message));
  assert.equal(paid.length, 2, 'nothing paid after the price rose, without budget or without balance');
});

test('pay route: quoted before the 402; the price function asks the quote; the paid call pays the seller', async () => {
  const state = { amount: 10000 };
  const paid = [];
  const quotes = createQuotes();
  const env = { PUBLIC_URL: 'https://buy.test', AGENT_PAYOUT_WALLET: PAY_TO, XRPL_XRP: 'off' };
  const noLog = { middleware: () => (_req, _res, next) => next(), record() {} };
  const app = createBuyApp({ env, deps: { safeFetch: sellerFetch(state), sanctions: null, trustIndex: null, lure: null, answerCheck: { enabled: false }, filler: { enabled: false }, wallet: null, payWallet: { address: '0xBuy', payFetch: async (url, init) => { paid.push({ url, method: init.method }); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); }, balance: async () => 5_000_000 }, budget: createBudget({ dailyUsd: 5 }), usageLog: noLog, signer: null, quotes, refusals: null } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const target = encodeURIComponent('https://seller.test/w?place=Amsterdam');
    // No paywall in this test: the quote is made, then the handler pays (the real paywall sits between them).
    const r = await fetch(`${base}/v1/pay?url=${target}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.paid.total_usd, 0.012);
    assert.deepEqual(JSON.parse(r.headers.get('x-fizzl-pay-quote')), { seller_usd: 0.01, fee_usd: 0.002, total_usd: 0.012 });
    assert.deepEqual(paid, [{ url: 'https://seller.test/w?place=Amsterdam', method: 'GET' }]);
    // The paywall's price for this endpoint is the quote; for an endpoint never quoted there is none.
    const route = routesFor(env, { quotes, publicUrl: 'https://buy.test' })['POST /v1/pay'];
    assert.ok(route.accepts.length === 0 || typeof route.accepts[0].price === 'function');
    const priceOf = (url) => { const r2 = routesFor({ ...env, AGENT_PAYOUT_WALLET_SOLANA: 'So1' }, { quotes, publicUrl: 'https://buy.test' })['POST /v1/pay']; return r2.accepts[0].price({ adapter: { getUrl: () => `/v1/pay?url=${encodeURIComponent(url)}` } }); };
    assert.equal(priceOf('https://seller.test/w?place=Amsterdam'), '$0.012');
    assert.equal(priceOf('https://never.test/x'), null);
    assert.equal(routesFor(env)['POST /v1/pay'], undefined, 'no pay route without the quotes');
    // The Bazaar entry: without it CDP settles /v1/pay but never lists it. The endpoint goes in the query.
    const { validateDiscoveryExtension } = require('@x402/extensions/bazaar');
    const bazaar = route.extensions.bazaar;
    assert.deepEqual(validateDiscoveryExtension(bazaar), { valid: true });
    assert.equal(bazaar.info.input.method, 'POST');
    assert.match(bazaar.info.input.queryParams.url, /^https:\/\//);
    assert.deepEqual(bazaar.schema.properties.input.properties.queryParams.required, ['url']);
    assert.ok(route.tags.length <= 5, `x402 allows 5 tags, the pay route has ${route.tags.length}`);
    // Refused before any 402: http, over the cap.
    assert.equal((await fetch(`${base}/v1/pay?url=${encodeURIComponent('http://seller.test/w')}`, { method: 'POST' })).status, 400);
    state.amount = 5_000_000;
    const over = await fetch(`${base}/v1/pay?url=${encodeURIComponent('https://seller.test/other')}`, { method: 'POST' });
    assert.equal(over.status, 422);
    assert.match((await over.json()).error, /up to \$1 a call/);
  } finally {
    server.close();
  }
});

test('pay route end to end: the real paywall asks the quote on the agent\'s chain, and settles only a delivered call', async () => {
  const http = require('node:http');
  const { verifyTypedData } = require('viem');
  const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
  const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
  const { ExactEvmScheme } = require('@x402/evm/exact/client');
  const { ExactEvmScheme: ExactEvmServer } = require('@x402/evm/exact/server');
  const { x402ResourceServer, paymentMiddleware } = require('@x402/express');
  const { HTTPFacilitatorClient } = require('@x402/core/server');
  const POLYGON = 'eip155:137';
  const closers = [];
  const listen = (h) => new Promise((r) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)); closers.push(s); });
  const send = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
  const fac = { verify: 0, settle: 0, amounts: [] };
  const facilitator = await listen(async (req, res) => {
    if (req.url.endsWith('/supported')) return send(res, { kinds: [{ x402Version: 2, scheme: 'exact', network: POLYGON }, { x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: {} });
    let raw = ''; for await (const c of req) raw += c;
    const { paymentPayload, paymentRequirements: reqs } = JSON.parse(raw);
    const { authorization, signature } = paymentPayload.payload;
    const valid = await verifyTypedData({ address: authorization.from, domain: { name: reqs.extra.name, version: reqs.extra.version, chainId: 137, verifyingContract: reqs.asset }, types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, primaryType: 'TransferWithAuthorization', message: authorization, signature });
    if (req.url.endsWith('/verify')) { fac.verify++; fac.amounts.push(reqs.amount); return send(res, valid ? { isValid: true, payer: authorization.from } : { isValid: false, invalidReason: 'invalid_signature', payer: authorization.from }); }
    fac.settle++;
    return send(res, { success: true, transaction: '0xsettled', network: POLYGON, payer: authorization.from });
  });
  const state = { amount: 10000 };
  const answers = [];
  const paid = [];
  const quotes = createQuotes();
  const env = { PUBLIC_URL: 'https://buy.test', AGENT_PAYOUT_WALLET: PAY_TO, POLYGON_PAY_TO: PAY_TO, XRPL_XRP: 'off' };
  const routes = routesFor(env, { quotes, publicUrl: 'https://buy.test' });
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitator })).register(POLYGON, new ExactEvmServer()).register('eip155:8453', new ExactEvmServer());
  await resourceServer.initialize();
  const paywall = paymentMiddleware({ 'POST /v1/pay': routes['POST /v1/pay'] }, resourceServer, { appName: 'Fizzl Buy', testnet: false }, undefined, false);
  const noLog = { middleware: () => (_req, _res, next) => next(), record() {} };
  const app = createBuyApp({ env, paywall, resourceServer, deps: { safeFetch: sellerFetch(state), sanctions: null, trustIndex: null, lure: null, answerCheck: { enabled: false }, filler: { enabled: false }, wallet: null, payWallet: { address: '0xBuy', payFetch: async (url) => { paid.push(url); const a = answers.shift() ?? { status: 200, body: '{"temp_c":11}' }; return new Response(a.body, { status: a.status, headers: { 'content-type': 'application/json' } }); }, balance: async () => 5_000_000 }, budget: createBudget({ dailyUsd: 5 }), usageLog: noLog, signer: null, quotes, refusals: null } });
  const api = await listen(app);
  try {
    const url = `${api}/v1/pay?url=${encodeURIComponent('https://seller.test/w?place=Amsterdam')}`;
    const unpaid = await fetch(url, { method: 'POST' });
    assert.equal(unpaid.status, 402);
    const challenge = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64').toString());
    assert.deepEqual(challenge.accepts.map((a) => a.network), ['eip155:8453', POLYGON], 'Base itself, and the agent\'s chain');
    assert.equal(challenge.extensions?.bazaar?.info?.input?.queryParams?.method, 'GET', 'the 402 carries the Bazaar entry');
    assert.ok(challenge.accepts.every((a) => a.amount === '12000'), "the seller's $0.01 plus the $0.002 fee, in USDC");
    // A bare /v1/pay (how the CDP Bazaar re-checks it, query stripped) gets the 402 for the example endpoint...
    const bare = await fetch(`${api}/v1/pay`, { method: 'POST' });
    assert.equal(bare.status, 402, 'a bare /v1/pay answers 402, not 400');
    const bareChallenge = JSON.parse(Buffer.from(bare.headers.get('payment-required'), 'base64').toString());
    assert.ok(bareChallenge.accepts.length > 0 && bareChallenge.accepts.every((a) => a.amount === '12000'));
    // ...but a bare call that carries a payment is refused before the paywall: nothing verified, nothing settled.
    const bareClient = new x402Client((_v, accepts) => accepts.find((a) => a.network === POLYGON));
    bareClient.register(POLYGON, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
    const barePaid = await wrapFetchWithPayment(fetch, bareClient)(`${api}/v1/pay`, { method: 'POST' });
    assert.equal(barePaid.status, 400);
    assert.match((await barePaid.json()).error, /name the x402 endpoint.*Nothing was charged/);
    assert.deepEqual([fac.verify, fac.settle], [0, 0], 'a bare payment is never verified or settled');
    const client = new x402Client((_v, accepts) => accepts.find((a) => a.network === POLYGON));
    client.register(POLYGON, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
    const payFetch = wrapFetchWithPayment(fetch, client);
    const ok = await payFetch(url, { method: 'POST' });
    const out = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(out));
    assert.deepEqual(out.answer, { temp_c: 11 });
    assert.equal(fac.settle, 1, 'settled once the seller delivered');
    assert.deepEqual(paid, ['https://seller.test/w?place=Amsterdam']);
    // The seller doesn't deliver: the agent's payment is verified but not settled.
    answers.push({ status: 503, body: 'down' });
    const failed = await payFetch(url, { method: 'POST' });
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /did not deliver.*Nothing was charged/);
    assert.equal(fac.settle, 1, 'no second settlement');
    assert.ok(fac.amounts.every((a) => a === '12000'));
  } finally {
    closers.forEach((s) => s.close());
  }
});

test('pay: the server start gives the paywall and the app the same quotes (a 402 without options otherwise)', () => {
  // 26 Nov 2026: live, the 402 came back with no accepts, because the app quoted into its own store while the
  // paywall's price function read another. The start must pass one store to both.
  const src = require('node:fs').readFileSync(require.resolve('../buy-server'), 'utf8');
  const main = src.slice(src.indexOf('if (require.main === module)'));
  assert.match(main, /const quotes = createQuotes\(\);/);
  assert.match(main, /routesFor\(env, \{ quotes \}\)/);
  assert.match(main, /createBuyApp\(\{[^}]*deps: \{ quotes \}/);
});
