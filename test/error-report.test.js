// Error reports to Sentry without the SDK (lib/error-report.js): what is sent, what never is, the limits, and the
// Express handler.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createErrorReporter, parseDsn, framesOf } = require('../lib/error-report');

const DSN = 'https://abc123@o1.ingest.de.sentry.io/4507';

test('DSN: parsed into the envelope endpoint and key; anything else turns reporting off', () => {
  assert.deepEqual(parseDsn(DSN), { key: 'abc123', url: 'https://o1.ingest.de.sentry.io/api/4507/envelope/', dsn: DSN });
  assert.equal(parseDsn(''), null);
  assert.equal(parseDsn('not a url'), null);
  assert.equal(parseDsn('https://o1.ingest.sentry.io/4507'), null, 'no key');
  assert.equal(createErrorReporter({ dsn: undefined, service: 's' }).enabled, false);
});

test('stack frames: oldest first, app frames marked, paths shortened', () => {
  const frames = framesOf('Error: x\n    at inner (/opt/render/project/src/lib/a.js:10:5)\n    at Object.<anonymous> (/opt/render/project/src/node_modules/express/router.js:3:1)\n    at node:internal/timers:12:3');
  assert.deepEqual(frames.map((f) => [f.filename, f.in_app]), [['node:internal/timers', false], ['node_modules/express/router.js', false], ['lib/a.js', true]]);
});

test('a report: type, message, stack, service and the request path only; never headers, query, body or IP', async () => {
  const sent = [];
  const r = createErrorReporter({ dsn: DSN, service: 'x402-doctor', release: '2.3.0', fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true }; } });
  const req = { method: 'GET', protocol: 'https', hostname: 'x402-doctor.fizzl.eu', path: '/api/v1/preflight', url: '/api/v1/preflight?url=https://secret.example/x', headers: { 'payment-signature': 'SIG', 'x-fizzl-pass': 'PROOF', authorization: 'Bearer K' }, body: { key: 'K' }, ip: '1.2.3.4' };
  assert.equal(await r.report(new TypeError('boom'), { req }), true);
  const [head, type, event] = sent[0].init.body.split('\n').map((l) => JSON.parse(l));
  assert.equal(sent[0].url, 'https://o1.ingest.de.sentry.io/api/4507/envelope/');
  assert.match(sent[0].init.headers['x-sentry-auth'], /sentry_key=abc123/);
  assert.equal(head.dsn, DSN);
  assert.equal(type.type, 'event');
  assert.deepEqual([event.exception.values[0].type, event.exception.values[0].value, event.tags.service, event.release], ['TypeError', 'boom', 'x402-doctor', 'x402-doctor@2.3.0']);
  assert.deepEqual(event.request, { method: 'GET', url: 'https://x402-doctor.fizzl.eu/api/v1/preflight' });
  const all = sent[0].init.body;
  for (const secret of ['SIG', 'PROOF', 'Bearer', 'secret.example', '1.2.3.4', '"K"']) assert.ok(!all.includes(secret), `no ${secret}`);
});

test('limits: the same error once in 10 minutes, at most maxPerHour; a failed send never throws', async () => {
  let t = 0;
  const sent = [];
  const r = createErrorReporter({ dsn: DSN, service: 's', maxPerHour: 3, now: () => t, fetchImpl: async () => { sent.push(1); return { ok: true }; } });
  const same = new Error('same');
  assert.equal(await r.report(same), true);
  assert.equal(await r.report(same), false, 'a repeat within 10 minutes');
  t += 11 * 60e3;
  assert.equal(await r.report(same), true);
  assert.equal(await r.report(new Error('b')), true);
  assert.equal(await r.report(new Error('c')), false, 'over the hourly budget');
  const down = createErrorReporter({ dsn: DSN, service: 's', log: { warn() {} }, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(await down.report(new Error('x')), false);
});

test('Express: a 5xx is reported and answered as JSON without the stack; a 4xx (bad JSON) keeps its status, unreported', async () => {
  const sent = [];
  const r = createErrorReporter({ dsn: DSN, service: 's', fetchImpl: async (u, i) => { sent.push(i.body); return { ok: true }; } });
  const app = express();
  app.post('/json', express.json(), (_req, res) => res.json({ ok: true }));
  app.get('/boom', () => { throw new Error('kaput at /tmp/secret'); });
  app.use(r.expressHandler());
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const origError = console.error;
  console.error = () => {};
  try {
    const boom = await fetch(`${base}/boom`);
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error: 'internal error' });
    const bad = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    await new Promise((ok) => setTimeout(ok, 30));
    assert.equal(sent.length, 1, 'only the 5xx');
    assert.match(sent[0], /kaput/);
  } finally {
    console.error = origError;
    server.close();
  }
});
