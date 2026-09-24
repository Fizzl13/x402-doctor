const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createUsageLog, paymentOf, mcpToolCall } = require('../lib/usage-log');
const { createUsageReader } = require('../lib/usage-reader');
const { createApp } = require('../server');

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
  open.server.close();
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
