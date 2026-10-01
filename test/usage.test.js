const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createUsageLog, paymentOf, mcpToolCall, mcpPayment, agentOf } = require('../lib/usage-log');
const { createUsageReader } = require('../lib/usage-reader');
const { createApp } = require('../server');
const { setupsFunnel } = require('../lib/usage-funnel');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const quiet = { warn() {}, error() {} };
const trustStub = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };

// A stand-in for the GitHub contents, trees and blobs APIs, backed by a Map.
function fakeGitHub({ conflictOnce = false } = {}) {
  const files = new Map(); // path -> text
  const shas = new Map(); // path -> sha
  let version = 0;
  let conflicted = false;
  const calls = [];
  const setFile = (path, text) => {
    files.set(path, text);
    shas.set(path, `sha${++version}`);
  };
  async function fetchFn(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    const contents = /\/contents\/(.+)$/.exec(u.pathname);
    if (contents) {
      const path = contents[1];
      if (method === 'GET') {
        if (!files.has(path)) return new Response('{}', { status: 404 });
        return Response.json({ sha: shas.get(path), content: Buffer.from(files.get(path)).toString('base64') });
      }
      const body = JSON.parse(opts.body);
      if (conflictOnce && !conflicted) {
        conflicted = true;
        return new Response('{}', { status: 409 });
      }
      if (files.has(path) && body.sha !== shas.get(path)) return new Response('{}', { status: 409 });
      setFile(path, Buffer.from(body.content, 'base64').toString('utf8'));
      return Response.json({}, { status: 201 });
    }
    if (/\/git\/trees\//.test(u.pathname)) {
      return Response.json({ tree: [...files.keys()].map((path) => ({ path, type: 'blob', sha: shas.get(path) })) });
    }
    const blob = /\/git\/blobs\/(.+)$/.exec(u.pathname);
    if (blob) {
      const entry = [...shas].find(([, s]) => s === blob[1]);
      return entry ? new Response(files.get(entry[0])) : new Response('{}', { status: 404 });
    }
    return new Response('{}', { status: 404 });
  }
  return { files, calls, setFile, fetchFn };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('usage log: appends one JSON line per call to events/<service>/<day>.jsonl, clipped', async () => {
  const gh = fakeGitHub();
  const log = createUsageLog({ service: 'presign', env: { USAGE_LOG_TOKEN: 't' }, fetchFn: gh.fetchFn, now: () => new Date('2026-09-24T10:00:00Z'), log: quiet });
  log.record({ route: 'check', input: { type: 'signature', typedData: { big: 'x'.repeat(1000) } }, result: { verdict: 'red' } });
  await log.flush();
  log.record({ route: 'check', input: { type: 'approval' }, result: { verdict: 'orange' } });
  await log.flush();
  const lines = gh.files.get('events/presign/2026-09-24.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].service, 'presign');
  assert.equal(lines[0].t, '2026-09-24T10:00:00.000Z');
  assert.ok(lines[0].input.typedData.length <= 301, 'long input is cut');
  assert.equal(lines[1].result.verdict, 'orange');
});

test('usage log: retries a write that lost a race', async () => {
  const gh = fakeGitHub({ conflictOnce: true });
  const log = createUsageLog({ service: 'doctor', env: { USAGE_LOG_TOKEN: 't' }, fetchFn: gh.fetchFn, log: quiet });
  log.record({ route: 'diagnose', input: { url: 'https://x.test' } });
  await log.flush();
  assert.equal([...gh.files.values()][0].trim().split('\n').length, 1);
});

test('usage log: without a token nothing is sent', async () => {
  const gh = fakeGitHub();
  const log = createUsageLog({ service: 'doctor', env: {}, fetchFn: gh.fetchFn, log: quiet });
  log.record({ route: 'diagnose' });
  await log.flush();
  assert.equal(gh.calls.length, 0);
  assert.equal(log.enabled, false);
});

test('paymentOf: amount and network from the payment header, tx and payer from the settlement', () => {
  const req = { headers: { 'payment-signature': b64({ accepted: { amount: '20000', network: 'eip155:8453' } }) } };
  const res = { getHeader: (k) => (k === 'PAYMENT-RESPONSE' ? b64({ success: true, transaction: '0xtx', network: 'eip155:8453', payer: '0xpayer' }) : undefined) };
  assert.deepEqual(paymentOf(req, res), { usd: 0.02, network: 'base', payer: '0xpayer', tx: '0xtx' });
  assert.equal(paymentOf({ headers: {} }, { getHeader: () => undefined }), null);
});

test('mcpToolCall finds the tools/call in a JSON-RPC body', () => {
  assert.deepEqual(mcpToolCall({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'ichimoku_trend', arguments: { pair: 'BTC-USDT' } } }), { tool: 'ichimoku_trend', args: { pair: 'BTC-USDT' } });
  assert.equal(mcpToolCall({ method: 'tools/list' }), null);
});

test('mcpPayment: amount from the call, settlement from the result', () => {
  const call = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'ichimoku_signal', _meta: { 'x402/payment': { accepted: { amount: '20000', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' } } } } };
  const reply = { jsonrpc: '2.0', result: { content: [], _meta: { 'x402/payment-response': { success: true, transaction: '5tx', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payer: 'Payer' } } } };
  assert.deepEqual(mcpPayment(call, reply), { usd: 0.02, network: 'solana', payer: 'Payer', tx: '5tx' });
  assert.equal(mcpPayment(call, { jsonrpc: '2.0', result: { content: [] } }), null);
});

test('middleware: reads a JSON body written with res.end (MCP transport)', async () => {
  const gh = fakeGitHub();
  const usageLog = createUsageLog({ service: 'ichimoku', env: { USAGE_LOG_TOKEN: 't' }, fetchFn: gh.fetchFn, now: () => new Date('2026-09-24T10:00:00Z'), log: quiet });
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(usageLog.middleware((req, _res, body) => ({ route: 'mcp', input: mcpToolCall(req.body), result: { ok: Boolean(body && body.result) }, payment: mcpPayment(req.body, body) })));
  app.post('/mcp', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [], _meta: { 'x402/payment-response': { success: true, transaction: '0xabc', network: 'eip155:8453', payer: '0xp' } } } }));
  });
  const { server, base } = await listen(app);
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ichimoku_signal', arguments: { pair: 'BTC-USDT' }, _meta: { 'x402/payment': { accepted: { amount: '20000', network: 'eip155:8453' } } } } };
  await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call) });
  await new Promise((r) => setTimeout(r, 30));
  await usageLog.flush();
  server.close();
  const [line] = gh.files.get('events/ichimoku/2026-09-24.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(line.paid, true);
  assert.equal(line.usd, 0.02);
  assert.equal(line.tx, '0xabc');
  assert.equal(line.input.tool, 'ichimoku_signal');
  assert.equal(line.result.ok, true);
});

test('middleware: a 402 is logged as a quote with the caller type, a refused payment as payment_failed', async () => {
  const gh = fakeGitHub();
  const usageLog = createUsageLog({ service: 'ichimoku', env: { USAGE_LOG_TOKEN: 't' }, fetchFn: gh.fetchFn, now: () => new Date('2026-09-24T10:00:00Z'), log: quiet });
  const express = require('express');
  const app = express();
  app.use(usageLog.middleware((req, _res, body) => ({ route: 'signal', input: { pair: 'BTC-USDT' }, result: { signal: body && body.signal } })));
  app.get('/signal', (req, res) => (req.query.pay ? res.json({ signal: 'bullish' }) : res.status(402).json({ x402Version: 2, accepts: [] })));
  const { server, base } = await listen(app);
  await fetch(`${base}/signal`, { headers: { 'user-agent': 'SmitheryBot/1.0 (+https://smithery.ai)' } });
  await fetch(`${base}/signal`, { headers: { 'user-agent': 'python-requests/2.32.3', 'payment-signature': b64({ bad: true }) } });
  await fetch(`${base}/signal?pay=1`, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' } });
  await new Promise((r) => setTimeout(r, 30));
  await usageLog.flush();
  server.close();
  const lines = gh.files.get('events/ichimoku/2026-09-24.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0].status, lines[0].quote, lines[0].agent, lines[0].paid, lines[0].result], [402, true, 'SmitheryBot/1.0', false, undefined]);
  assert.equal(lines[0].payment_failed, undefined, 'no payment offered: just saw the price');
  assert.deepEqual([lines[1].quote, lines[1].payment_failed, lines[1].agent], [true, true, 'python-requests/2.32.3']);
  assert.deepEqual([lines[2].status, lines[2].quote, lines[2].agent, lines[2].result.signal], [200, undefined, 'browser', 'bullish']);
});

test('agentOf: a short caller label, never the full User-Agent', () => {
  assert.equal(agentOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'browser');
  assert.equal(agentOf('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Googlebot/2.1');
  assert.equal(agentOf('x402-doctor-trust-scan/1.0 (+https://x402-doctor.fizzl.eu/trust)'), 'x402-doctor-trust-scan/1.0');
  assert.equal(agentOf('axios/1.7.2'), 'axios/1.7.2');
  assert.equal(agentOf(undefined), 'none');
});

test('usage reader: reads the day files in range, newest first', async () => {
  const gh = fakeGitHub();
  gh.setFile('events/doctor/2026-09-24.jsonl', '{"t":"2026-09-24T09:00:00.000Z","service":"doctor"}\n{"t":"2026-09-24T11:00:00.000Z","service":"doctor"}\n');
  gh.setFile('events/ichimoku/2026-01-01.jsonl', '{"t":"2026-01-01T00:00:00.000Z","service":"ichimoku"}\n');
  const reader = createUsageReader({ env: { USAGE_LOG_TOKEN: 't' }, fetchFn: gh.fetchFn, now: () => Date.parse('2026-09-24T12:00:00Z') });
  const out = await reader.load({ days: 7 });
  assert.equal(out.configured, true);
  assert.deepEqual(out.events.map((e) => e.t), ['2026-09-24T11:00:00.000Z', '2026-09-24T09:00:00.000Z']);
  assert.ok(!gh.calls.some((c) => c.includes('2026-01-01')), 'old day files are not downloaded');
});

test('usage reader: not configured without a token', async () => {
  const out = await createUsageReader({ env: {} }).load();
  assert.equal(out.configured, false);
});

test('admin pages: 404 without ADMIN_PASSWORD, 401 without the password, data with it', async () => {
  const usageReader = { load: async ({ days }) => ({ configured: true, repo: 'r', days, events: [{ t: '2026-09-24T00:00:00Z', service: 'doctor' }] }) };
  const closed = await listen(createApp({ env: {}, trustIndex: trustStub, usageReader }));
  assert.equal((await fetch(`${closed.base}/admin/usage`)).status, 404);
  closed.server.close();

  const open = await listen(createApp({ env: { ADMIN_PASSWORD: 'pw' }, trustIndex: trustStub, usageReader }));
  const auth = (p) => ({ headers: { authorization: `Basic ${Buffer.from(`me:${p}`).toString('base64')}` } });
  assert.equal((await fetch(`${open.base}/admin/usage`)).status, 401);
  assert.equal((await fetch(`${open.base}/admin/usage`, auth('wrong'))).status, 401);
  const page = await fetch(`${open.base}/admin/usage`, auth('pw'));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Usage/);
  const data = await (await fetch(`${open.base}/admin/usage/data?days=7`, auth('pw'))).json();
  assert.equal(data.days, 7);
  assert.equal(data.events.length, 1);
  assert.equal(data.funnel.preview_visitors, 0);
  assert.match(await (await fetch(`${open.base}/admin/usage`, auth('pw'))).text(), /id="funnel"/);
  assert.match(await (await fetch(`${open.base}/admin/usage`, auth('pw'))).text(), /id="packages"[\s\S]*id="pkgOnly"|id="pkgOnly"[\s\S]*id="packages"/);
  open.server.close();
});

test('admin pages: 10 wrong passwords from one IP lock it out, even with the right password', async () => {
  const usageReader = { load: async ({ days }) => ({ configured: true, repo: 'r', days, events: [] }) };
  const { server, base } = await listen(createApp({ env: { ADMIN_PASSWORD: 'pw' }, trustIndex: trustStub, usageReader }));
  const auth = (p) => ({ headers: { authorization: `Basic ${Buffer.from(`me:${p}`).toString('base64')}` } });
  // The browser's first request carries no credentials: not a failed attempt.
  for (let i = 0; i < 12; i++) assert.equal((await fetch(`${base}/admin/usage`)).status, 401);
  assert.equal((await fetch(`${base}/admin/usage`, auth('pw'))).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/admin/usage`, auth(`guess${i}`))).status, 401);
  const locked = await fetch(`${base}/admin/usage`, auth('pw'));
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  server.close();
});

test('admin lockout is per caller behind Render\'s three proxy hops, and a faked entry does not dodge it', async () => {
  const usageReader = { load: async ({ days }) => ({ configured: true, repo: 'r', days, events: [] }) };
  const { server, base } = await listen(createApp({ env: { ADMIN_PASSWORD: 'pw' }, trustIndex: trustStub, usageReader }));
  // As measured on Render: caller, a middle hop, then a private Render address.
  const from = (chain, p) => ({ headers: { 'x-forwarded-for': chain, authorization: `Basic ${Buffer.from(`me:${p}`).toString('base64')}` } });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/admin/usage`, from('203.0.113.7, 104.16.0.1, 10.0.0.5', `guess${i}`))).status, 401);
    assert.equal((await fetch(`${base}/admin/usage`, from('203.0.113.7, 104.16.0.1, 10.0.0.5', 'pw'))).status, 429, 'the guesser is locked out');
    assert.equal((await fetch(`${base}/admin/usage`, from('93.184.216.34, 104.16.0.1, 10.0.0.5', 'pw'))).status, 200, 'another caller through the same hops is not');
    assert.equal((await fetch(`${base}/admin/usage`, from('1.2.3.4, 203.0.113.7, 104.16.0.1, 10.0.0.5', 'pw'))).status, 429, 'a faked leading entry changes nothing');
  } finally {
    server.close();
  }
});

test('nohumans claim: a pending token goes on its endpoint only; none pending now', async () => {
  const express = require('express');
  const { nohumansClaim, CLAIMS } = require('../lib/nohumans-claim');
  assert.deepEqual(CLAIMS.headers, {}, 'no claim pending');
  const app = express();
  app.use(nohumansClaim({ headers: { '/api/v1/preflight': 'tok' }, wellKnown: null }));
  app.get('*', (_req, res) => res.status(402).end());
  const { server, base } = await listen(app);
  try {
    assert.equal((await fetch(`${base}/api/v1/preflight`)).headers.get('x-nohumans-claim'), 'tok');
    assert.equal((await fetch(`${base}/api/v1/fix`)).headers.get('x-nohumans-claim'), null);
    assert.equal((await fetch(`${base}/.well-known/nohumans-claim`)).headers.get('x-nohumans-claim'), null);
  } finally {
    server.close();
  }
});

test('every response carries the security headers', async () => {
  const { server, base } = await listen(createApp({ env: {}, trustIndex: trustStub }));
  for (const path of ['/', '/.well-known/x402-trust.txt', '/api/v1/diagnose']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
    assert.match(res.headers.get('strict-transport-security'), /max-age=31536000/, path);
    assert.equal(res.headers.get('x-powered-by'), null, path);
  }
  server.close();
});

test('doctor: a web diagnosis is logged with what was asked, static files are not', async () => {
  const gh = fakeGitHub();
  const usageLog = createUsageLog({ service: 'doctor', env: { USAGE_LOG_TOKEN: 't' }, fetchFn: gh.fetchFn, now: () => new Date('2026-09-24T10:00:00Z'), log: quiet });
  const { server, base } = await listen(createApp({ env: {}, trustIndex: trustStub, usageLog }));
  await fetch(`${base}/api/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'not a url' }) });
  await fetch(`${base}/`);
  await new Promise((r) => setTimeout(r, 30));
  await usageLog.flush();
  server.close();
  const lines = (gh.files.get('events/doctor/2026-09-24.jsonl') || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].route, 'diagnose');
  assert.equal(lines[0].via, 'web');
  assert.equal(lines[0].status, 400);
  assert.equal(lines[0].paid, false);
  assert.deepEqual(lines[0].input, { url: 'not a url' });
  assert.equal(lines[0].result.error, 'Not a valid URL.');
});

test('usage log middleware: a body written as a Uint8Array (the MCP transport) reaches describe', async () => {
  const gh = fakeGitHub();
  const log = createUsageLog({ service: 'doctor', env: { USAGE_LOG_TOKEN: 't' }, fetchFn: gh.fetchFn, now: () => new Date('2026-09-26T10:00:00Z'), log: quiet });
  const mw = log.middleware((_req, _res, body) => ({ route: 'x402_quick_check', via: 'mcp', result: { overall: body && body.result && JSON.parse(body.result.content[0].text).overall } }));
  const app = require('express')();
  app.use(mw);
  app.post('/mcp', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const reply = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ overall: 'pass' }) }] } };
    res.end(new TextEncoder().encode(JSON.stringify(reply)));
  });
  const { server, base } = await listen(app);
  await fetch(`${base}/mcp`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 30));
  await log.flush();
  server.close();
  const line = JSON.parse(gh.files.get('events/doctor/2026-09-26.jsonl').trim());
  assert.deepEqual(line.result, { overall: 'pass' });
});

test('visitor code: stable per IP and secret, never the IP itself', () => {
  const { visitorOf } = require('../lib/usage-log');
  assert.match(visitorOf('203.0.113.7', 's1'), /^[0-9a-f]{12}$/);
  assert.equal(visitorOf('::ffff:203.0.113.7', 's1'), visitorOf('203.0.113.7', 's1'));
  assert.notEqual(visitorOf('203.0.113.7', 's1'), visitorOf('203.0.113.7', 's2'));
  assert.equal(visitorOf('203.0.113.7', undefined), undefined);
});

test('setups funnel: preview visitors, then the price, then a paid /setups within 24 hours', () => {
  const ev = (t, visitor, route, extra = {}) => ({ t: `2026-09-27T${t}:00Z`, service: 'ichimoku', route, visitor, status: 200, ...extra });
  const events = [
    ev('10:00', 'a', 'setups_preview', { via: 'web' }),
    ev('10:05', 'a', 'setups', { quote: true, status: 402 }),
    ev('10:06', 'a', 'setups', { paid: true, usd: 0.5 }),
    ev('11:00', 'b', 'setups_preview', { via: 'api' }),
    ev('11:01', 'b', 'setups_preview', { via: 'api' }),
    ev('11:02', 'b', 'setups', { quote: true, status: 402 }),
    ev('12:00', 'c', 'setups_preview', { via: 'web' }),
    ev('09:00', 'c', 'trade_setups', { paid: true, usd: 0.5 }), // before c's preview
    ev('13:00', 'd', 'trade_setups', { paid: true, usd: 0.5 }), // MCP agent, never previewed
    ev('13:00', 'e', 'setups_preview', { status: 502 }), // a failed preview does not count
    { t: '2026-09-27T13:00:00Z', service: 'doctor', route: 'setups_preview', visitor: 'f', status: 200 },
  ].sort((x, y) => (x.t < y.t ? 1 : -1));
  assert.deepEqual(setupsFunnel(events), {
    window_hours: 24,
    preview_calls: 4,
    preview_visitors: 3,
    preview_visitors_web: 2,
    saw_price: 2,
    paid: 1,
    revenue_after_preview: 0.5,
    paid_calls_without_preview: 2,
    revenue_without_preview: 1,
  });
});

test('setups funnel: a payment more than 24 hours after the preview is not counted as following it', () => {
  const f = setupsFunnel([
    { t: '2026-09-28T11:00:00Z', service: 'ichimoku', route: 'setups', visitor: 'a', status: 200, paid: true, usd: 0.5 },
    { t: '2026-09-27T10:00:00Z', service: 'ichimoku', route: 'setups_preview', visitor: 'a', status: 200 },
  ]);
  assert.equal(f.paid, 0);
  assert.equal(f.paid_calls_without_preview, 1);
});

test('feedback in the app: a long report passes (its own parser, not the 4 kB one) and lands in the usage log', async () => {
  const recorded = [];
  const usageLog = { record: (e) => recorded.push(e), middleware: () => (_req, _res, next) => next() };
  const { server, base } = await listen(createApp({ env: {}, trustIndex: trustStub, usageLog, usageReader: { load: async () => ({}) } }));
  const message = 'é'.repeat(1990); // about 4 kB in UTF-8
  const res = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'bug', message, endpoint: '/api/v1/fix' }) });
  assert.equal(res.status, 202);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].route, 'feedback');
  assert.equal(recorded[0].feedback.message, message);
  server.close();
});
