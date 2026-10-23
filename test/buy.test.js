// Fizzl Buy (buy-server.js, lib/buy/*): candidates from the catalog search, the request filled in, the purchase with
// its preflight, budget, wallet and answer check, falling back to the next candidate, and the server's routes. No
// real payment: a local seller answers the preflight's 402, and payFetch is a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { candidatesFor, leftOut } = require('../lib/buy/search');
const { createFiller, requestOf } = require('../lib/buy/fill');
const { buy, createBudget, BuyError } = require('../lib/buy/purchase');
const { createBuyApp, routesFor } = require('../buy-server');
const { createSafeFetch } = require('../lib/safe-fetch');
const { paymentKey } = require('../lib/buy/once');
const { spentByOthers } = require('../lib/buy/spent-log');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const servers = [];
test.after(() => servers.forEach((s) => s.close()));

// A seller whose every path answers a 402 for amount (atomic USDC on Base) without a payment.
function seller(amount = '2000') {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}`, description: 'weather', mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount, asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
      res.statusCode = 402;
      res.setHeader('content-type', 'application/json');
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
      res.end(JSON.stringify(challenge));
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}

const result = (url, { usd = 0.002, relevance = 0.95, days = 30, ratio = 1, method = 'GET', example = { place: 'London', days: 3 } } = {}) => ({ url, host: new URL(url).host, description: `weather at ${url}`, method, example, prices: [{ network: 'Base', usd }], relevance, record: { days, payableDays: Math.round(days * ratio), ratio } });
const searchFetch = (results, calls = []) => async (url) => { calls.push(String(url)); return Response.json({ query: 'x', results }); };

test('search: only what may be bought, best first; the search URL carries the need and the cap', async () => {
  const calls = [];
  const out = await candidatesFor('weather amsterdam', { capUsd: 0.01, fetch: searchFetch([
    result('https://a.test/w', { relevance: 0.9, usd: 0.005 }),
    result('https://b.test/w', { relevance: 0.99, ratio: 0.9 }),
    result('https://c.test/w', { relevance: 0.99, ratio: 1, usd: 0.003 }),
    result('https://d.test/w', { usd: 0.02 }),
    result('https://e.test/w', { days: 2 }),
    result('https://f.test/w', { ratio: 0.5 }),
    result('https://g.test/w', { relevance: 0.3 }),
    result('https://buy.fizzl.eu/v1/buy'),
    { ...result('https://h.test/w'), prices: [{ network: 'Solana', usd: 0.001 }] },
  ], calls) });
  assert.deepEqual(out.map((c) => c.url), ['https://c.test/w', 'https://b.test/w', 'https://a.test/w']);
  assert.deepEqual(out[0], { url: 'https://c.test/w', method: 'GET', description: 'weather at https://c.test/w', example: { place: 'London', days: 3 }, price_usd: 0.003, relevance: 0.99, record: { days: 30, payableDays: 30, ratio: 1 } });
  assert.match(calls[0], /q=weather\+amsterdam&max=0\.01&net=eip155%3A8453/);
  assert.equal(leftOut(result('https://d.test/w', { usd: 0.02 }), 0.01), 'price $0.02 above the cap of $0.01');
  await assert.rejects(candidatesFor('x', { capUsd: 0.01, fetch: async () => new Response('', { status: 500 }) }), (e) => e.status === 503);
});

test('fill: Claude answers the input; path parameters into the path, the rest into the query or the body', async () => {
  assert.deepEqual(requestOf({ url: 'https://a.test/w/:city', method: 'GET' }, { city: 'Amsterdam', days: 2 }), { method: 'GET', url: 'https://a.test/w/Amsterdam?days=2', body: undefined });
  assert.deepEqual(requestOf({ url: 'https://a.test/w', method: 'POST' }, { place: 'Amsterdam' }), { method: 'POST', url: 'https://a.test/w', body: '{"place":"Amsterdam"}' });
  assert.equal(requestOf({ url: 'https://a.test/p/{symbol}' }, {}), null);
  const claude = (answer) => async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(JSON.parse(body.messages[0].content).api.example_input.place, 'London');
    return Response.json({ content: [{ type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }] });
  };
  const c = { url: 'https://a.test/w', method: 'GET', description: 'weather', example: { place: 'London', days: 3 } };
  const ok = await createFiller({ apiKey: 'k', fetch: claude({ fits: true, input: { place: 'Amsterdam', days: 2 }, reason: 'weather for a place' }) }).fill('weather Amsterdam tomorrow', c);
  assert.deepEqual(ok.request, { method: 'GET', url: 'https://a.test/w?place=Amsterdam&days=2', body: undefined });
  assert.equal((await createFiller({ apiKey: 'k', fetch: claude({ fits: false, reason: 'a stock API' }) }).fill('weather', c)).reason, 'a stock API');
  assert.equal((await createFiller({ apiKey: 'k', fetch: claude('no json here') }).fill('weather', c)).fits, false);
  assert.match((await createFiller({ apiKey: '' }).fill('weather', c)).reason, /not set up/);
});

test('budget: per UTC day, rolling over at midnight', () => {
  let t = Date.parse('2026-10-23T10:00:00Z');
  const b = createBudget({ dailyUsd: 0.01, now: () => t });
  b.add(0.004);
  assert.equal(b.left(), 0.006);
  t = Date.parse('2026-10-24T00:00:01Z');
  assert.equal(b.left(), 0.01);
});

async function deps({ results, answers = [], checks = [], balance = 5_000_000, dailyUsd = 5 }) {
  const paid = [];
  const payFetch = async (url, init) => {
    paid.push({ url, method: init.method, body: init.body });
    const a = answers[paid.length - 1] ?? { status: 200, body: { temp_c: 11 } };
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
  let n = 0;
  const answerCheck = { enabled: true, check: async () => checks[n++] ?? { delivered: { verdict: 'yes', decidedBy: 'jev' }, injection: { flagged: false } } };
  const fill = async (_need, c) => ({ fits: true, request: { method: 'GET', url: `${c.url}?place=Amsterdam`, body: undefined }, input: { place: 'Amsterdam' } });
  return { paid, d: { fill, payFetch, balance: async () => balance, budget: createBudget({ dailyUsd }), answerCheck, safeFetch: createSafeFetch({ allowPrivate: true }), capUsd: 0.01, fetch: searchFetch(results) } };
}

test('purchase: the first candidate that delivers; a bad answer moves on to the next', async () => {
  const a = await seller();
  const b = await seller();
  const { paid, d } = await deps({ results: [result(`${a}/w`, { relevance: 0.99 }), result(`${b}/w`, { relevance: 0.9 })], answers: [{ status: 200, body: 'demo data' }, { status: 200, body: { temp_c: 11 } }], checks: [{ delivered: { verdict: 'no', why: 'a placeholder' } }] });
  const out = await buy({ need: 'weather amsterdam' }, d);
  assert.equal(out.delivered, true);
  assert.deepEqual(out.answer, { temp_c: 11 });
  assert.equal(out.service.url, `${b}/w?place=Amsterdam`);
  assert.equal(out.paid_usd, 0.002);
  assert.equal(out.tried, 2);
  assert.equal(out.attempts[0].step, 'answer');
  assert.equal(out.attempts[0].why, 'a placeholder');
  assert.equal(paid.length, 2);
  assert.equal(d.budget.spent(), 0.004, 'both payments count toward the day');
});

test('purchase: nothing delivered is a 502 with the attempts; a seller above the cap is not paid', async () => {
  const a = await seller('20000');
  const b = await seller();
  const { paid, d } = await deps({ results: [result(`${a}/w`, { usd: 0.005 }), result(`${b}/w`, { relevance: 0.9 })], answers: [{ status: 500, body: { error: 'down' } }] });
  const err = await buy({ need: 'weather' }, d).catch((e) => e);
  assert.ok(err instanceof BuyError);
  assert.equal(err.status, 502);
  assert.equal(err.attempts[0].step, 'preflight', 'the 402 now asks $0.02: no_go over the cap');
  assert.equal(err.attempts[1].why, 'HTTP 500');
  assert.equal(paid.length, 1);
});

test('purchase: an empty day budget or wallet stops before paying; no candidates is a 404', async () => {
  const a = await seller();
  const broke = await deps({ results: [result(`${a}/w`)], balance: 1000 });
  assert.equal((await buy({ need: 'weather' }, broke.d).catch((e) => e)).status, 503);
  assert.equal(broke.paid.length, 0);
  const spent = await deps({ results: [result(`${a}/w`)], dailyUsd: 0.001 });
  assert.match((await buy({ need: 'weather' }, spent.d).catch((e) => e)).message, /budget for today/);
  const none = await deps({ results: [] });
  assert.equal((await buy({ need: 'weather' }, none.d).catch((e) => e)).status, 404);
});

test('server: free pick with its limit, the purchase, bad input, no wallet, discovery and MCP', async () => {
  const a = await seller();
  const { d } = await deps({ results: [result(`${a}/w`)] });
  const noLog = { middleware: () => (_req, _res, next) => next() };
  const app = createBuyApp({ env: { PUBLIC_URL: 'https://buy.test', AGENT_PAYOUT_WALLET: PAY_TO }, deps: { fetch: d.fetch, safeFetch: d.safeFetch, sanctions: null, trustIndex: null, lure: null, answerCheck: d.answerCheck, filler: { enabled: true, fill: d.fill }, wallet: { address: '0xBuy', payFetch: d.payFetch, balance: d.balance }, budget: d.budget, usageLog: noLog, signer: null, freeLimiter: (() => { let n = 0; return () => ++n <= 4; })() } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const pick = await (await fetch(`${base}/v1/pick?need=weather%20amsterdam`)).json();
  assert.equal(pick.pick.url, `${a}/w`);
  const fromSite = await fetch(`${base}/v1/pick?need=weather%20amsterdam`, { headers: { origin: 'https://fizzl.eu' } });
  assert.equal(fromSite.headers.get('access-control-allow-origin'), 'https://fizzl.eu', 'the live demo on fizzl.eu');
  assert.equal((await fetch(`${base}/v1/pick?need=weather%20amsterdam`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null);
  assert.deepEqual(pick.buy, { method: 'POST', url: 'https://buy.test/v1/buy', body: { need: 'weather amsterdam' }, price_usd: 0.02, note: pick.buy.note });
  assert.equal((await fetch(`${base}/v1/pick?need=x`)).status, 400);
  const bought = await fetch(`${base}/v1/buy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ need: 'weather amsterdam' }) });
  assert.equal(bought.status, 200);
  assert.deepEqual((await bought.json()).answer, { temp_c: 11 });
  assert.equal((await fetch(`${base}/v1/buy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  const mcp = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json();
  assert.deepEqual(mcp.result.tools.map((t) => t.name), ['x402_pick']);
  assert.equal((await fetch(`${base}/v1/pick?need=weather%20amsterdam`)).status, 200);
  assert.equal((await fetch(`${base}/v1/pick?need=weather%20amsterdam`)).status, 429, 'the free limit');
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  assert.equal(spec.paths['/v1/buy'].post['x-payment-info'].price.amount, '0.02');
  assert.equal((await (await fetch(`${base}/.well-known/x402`)).json()).resources[0].url, 'https://buy.test/v1/buy');
  assert.match(await (await fetch(`${base}/llms.txt`)).text(), /POST https:\/\/buy\.test\/v1\/buy/);
  assert.match(await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text(), /Fizzl Buy/);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.wallet, '0xBuy');

  const walletless = createBuyApp({ env: { AGENT_PAYOUT_WALLET: PAY_TO }, deps: { fetch: d.fetch, sanctions: null, trustIndex: null, lure: null, answerCheck: d.answerCheck, filler: { enabled: true, fill: d.fill }, wallet: null, usageLog: noLog, signer: null } });
  const s2 = await new Promise((r) => { const s = walletless.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(s2);
  const r503 = await fetch(`http://127.0.0.1:${s2.address().port}/v1/buy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ need: 'weather amsterdam' }) });
  assert.equal(r503.status, 503);
});

test('routes: $0.02 on Base, and on Solana with a Solana payout address; five minutes to buy; seller and Builder Code', () => {
  const r = routesFor({ AGENT_PAYOUT_WALLET: PAY_TO, AGENT_PAYOUT_WALLET_SOLANA: 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9' })['POST /v1/buy'];
  assert.deepEqual(r.accepts.map((a) => [a.network, a.price, a.maxTimeoutSeconds]), [['eip155:8453', '$0.02', 300], ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', '$0.02', 300]]);
  assert.equal(routesFor({ AGENT_PAYOUT_WALLET: PAY_TO })['POST /v1/buy'].accepts.length, 1);
  assert.equal(r.extensions.bazaar.info.input.body.need, 'weather forecast for Amsterdam tomorrow');
  assert.equal(r.extensions['x402-merchant'].info.name, 'Fizzl');
  assert.equal(r.extensions['builder-code'], undefined, 'no Builder Code without BUILDER_CODE');
  assert.equal(routesFor({ AGENT_PAYOUT_WALLET: PAY_TO, BUILDER_CODE: 'fizzl_test' })['POST /v1/buy'].extensions['builder-code'].info.a, 'fizzl_test');
});

test('budget: what earlier instances spent today counts, until the day rolls over', () => {
  let t = Date.parse('2026-10-23T10:00:00Z');
  const b = createBudget({ dailyUsd: 5, now: () => t });
  b.add(0.01);
  b.restore('2026-10-23', 1.2);
  assert.equal(b.spent(), 1.21);
  assert.equal(b.left(), 3.79);
  b.restore('2026-10-23', 1.5);
  assert.equal(b.spent(), 1.51, 'a later read replaces the earlier one');
  b.restore('2026-10-22', 4);
  assert.equal(b.spent(), 1.51, 'another day is ignored');
  t = Date.parse('2026-10-24T00:00:01Z');
  assert.equal(b.spent(), 0);
});

test('spent log: the other instances\' spending in today\'s usage-log file', async () => {
  const lines = [
    { route: 'buy', input: { chars: 20, spent_usd: 0.002, instance: 'old' } },
    { route: 'buy', input: { chars: 20 } },
    { route: 'buy', status: 402, quote: true, input: { chars: 20, spent_usd: 0.01, instance: 'old' } },
    { route: 'buy', input: { chars: 20, spent_usd: 0.005, instance: 'me' } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n';
  const seen = [];
  const fetchLog = async (url, init) => { seen.push({ url, auth: init.headers.authorization }); return new Response(lines, { status: 200 }); };
  assert.equal(await spentByOthers({ env: { USAGE_LOG_TOKEN: 't' }, fetch: fetchLog, day: '2026-10-23', instance: 'me' }), 0.012);
  assert.equal(seen[0].url, 'https://api.github.com/repos/Fizzl13/usage-log/contents/events/buy/2026-10-23.jsonl');
  assert.equal(seen[0].auth, 'Bearer t');
  assert.equal(await spentByOthers({ env: { USAGE_LOG_TOKEN: 't' }, fetch: async () => new Response('', { status: 404 }), day: '2026-10-23' }), 0);
  assert.equal(await spentByOthers({ env: {}, fetch: fetchLog, day: '2026-10-23' }), null);
});

test('once per payment: the payer and nonce on EVM, the transaction on Solana', () => {
  const header = (p) => Buffer.from(JSON.stringify(p)).toString('base64');
  const evm = (nonce, extra = {}) => header({ x402Version: 2, accepted: { network: 'eip155:8453' }, payload: { signature: '0xs', authorization: { from: '0xAbC', nonce }, ...extra } });
  assert.equal(paymentKey(evm('0x01')), 'eip155:8453:0xabc:0x01');
  assert.equal(paymentKey(evm('0x01', { signature: '0xother' })), paymentKey(evm('0x01')), 'the same authorization, whatever else changes');
  assert.match(paymentKey(header({ x402Version: 2, accepted: { network: 'solana:x' }, payload: { transaction: 'AAAA' } })), /^solana:x:tx:[0-9a-f]{64}$/);
  assert.equal(paymentKey('not base64 json'), null);
  assert.equal(paymentKey(header({ x402Version: 1, network: 'base' })), null);
});

test('server: one payment buys one answer; the day budget counts the other instances; the usage log gets the spend', async () => {
  const a = await seller();
  const { d } = await deps({ results: [result(`${a}/w`)] });
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const payFetch = async (url, init) => { calls++; if (calls === 1) await gate; return d.payFetch(url, init); };
  const logged = [];
  const usageLog = { middleware: (describe) => (req, res, next) => { res.on('finish', () => logged.push(describe(req, res, undefined))); next(); } };
  const app = createBuyApp({ env: { AGENT_PAYOUT_WALLET: PAY_TO }, deps: { fetch: d.fetch, safeFetch: d.safeFetch, sanctions: null, trustIndex: null, lure: null, answerCheck: d.answerCheck, filler: { enabled: true, fill: d.fill }, wallet: { address: '0xBuy', payFetch, balance: d.balance }, budget: d.budget, usageLog, signer: null, instance: 'me', spentByOthers: async ({ day, instance }) => (instance === 'me' && /^\d{4}-\d\d-\d\d$/.test(day) ? 1.5 : 0) } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const pay = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: 'eip155:8453' }, payload: { authorization: { from: '0xa', nonce: '0x1' } } })).toString('base64');
  const post = (header) => fetch(`${base}/v1/buy`, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'payment-signature': header } : {}) }, body: JSON.stringify({ need: 'weather amsterdam' }) });

  const first = post(pay);
  while (calls === 0) await new Promise((r) => setTimeout(r, 5));
  const second = await post(pay);
  assert.equal(second.status, 409, 'the same payment while the first request runs');
  assert.match((await second.json()).error, /already in use/);
  release();
  assert.equal((await first).status, 200);
  const third = await post(pay);
  assert.equal(third.status, 409, 'and after it bought');
  assert.match((await third.json()).error, /already used/);
  assert.equal(calls, 1, 'one seller payment');

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.spent_today_usd, 1.502, 'the other instances\' $1.50 plus this purchase');
  const bought = logged.find((e) => e?.route === 'buy' && e.input.spent_usd);
  assert.deepEqual(bought.input, { chars: 17, spent_usd: 0.002, instance: 'me' });
  assert.equal(logged.filter((e) => e?.route === 'buy' && e.input.spent_usd).length, 1, 'the refused requests spent nothing');
});
