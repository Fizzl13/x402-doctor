// An async route that rejects must answer through the error handler, not take the process down (21 Nov 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { catchAsyncRoutes } = require('../lib/async-routes');

catchAsyncRoutes(express);

function serve(app) {
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

test('a rejected async handler reaches the error handler with its own status', async () => {
  const app = express();
  const router = express.Router();
  router.get('/r', async () => { throw Object.assign(new Error('nope'), { statusCode: 400 }); });
  app.get('/boom', async () => { await null; throw new Error('kaput'); });
  app.post('/blocked', express.json(), async () => { throw Object.assign(new Error('Cannot diagnose a local/internal address.'), { statusCode: 400 }); });
  app.get('/sync', () => { throw new Error('sync too'); });
  app.get('/ok', async (_req, res) => { res.json({ ok: true }); });
  app.use(router);
  const seen = [];
  app.use((err, req, res, _next) => { seen.push(err.message); res.status(err.statusCode || 500).json({ error: err.message }); });
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  const server = await serve(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/boom`)).status, 500);
    assert.equal((await fetch(`${base}/blocked`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/sync`)).status, 500);
    assert.equal((await fetch(`${base}/r`)).status, 400);
    const ok = await fetch(`${base}/ok`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.deepEqual(seen, ['kaput', 'Cannot diagnose a local/internal address.', 'sync too', 'nope']);
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    server.close();
  }
});

test('catchAsyncRoutes installs once; error handlers and routers keep their shape', () => {
  const { guard } = require('../lib/async-routes');
  const eh = (err, req, res, next) => next(err);
  assert.equal(guard(eh), eh);
  const r = express.Router();
  assert.equal(guard(r), r);
  const f = async () => {};
  const g = guard(f);
  assert.notEqual(g, f);
  assert.equal(guard(g), g);
  catchAsyncRoutes(express);
});

test('Doctor app: an async route that rejects answers 500 JSON and the server keeps serving', async (t) => {
  const { createApp } = require('../server.js');
  const { createTrustIndex } = require('../lib/trust-index');
  const empty = { updated: 'now', days: ['2026-11-21'], resources: {} };
  const app = createApp({
    env: {},
    status: { snapshot: async () => ({}) },
    trustIndex: createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', submittedUrl: 'http://submitted.test', fetchImpl: async () => Response.json(empty) }),
    trustSubmissions: { submit: async () => { throw new Error('store down'); }, list: async () => { throw new Error('usage log unreachable'); }, find: async () => null },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const err = console.error;
  console.error = () => {};
  try {
    const res = await fetch(`${base}/api/trust/submitted`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
    const sub = await fetch(`${base}/api/trust/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://seller.example/x' }) });
    assert.equal(sub.status, 500);
  } finally {
    console.error = err;
  }
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
