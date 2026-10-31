// GET and HEAD on a POST-only paid route (lib/post-only.js, Fizzl Buy's POST /v1/buy): the POST's 402 with
// Allow: POST, never a payment on a GET.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { postOnlyTerms } = require('../lib/post-only');

function server() {
  const seen = [];
  const paywall = (req, res, next) => {
    seen.push(`${req.method} ${req.path}`);
    if (req.method === 'POST' && req.path === '/v1/buy' && /text\/html/.test(req.get('accept') || '')) return res.status(402).type('html').send('<script>window.x402 = { testnet: true }</script>');
    if (req.method === 'POST' && req.path === '/v1/buy') return res.status(402).set('PAYMENT-REQUIRED', 'terms').json({});
    next();
  };
  const app = express();
  app.use(postOnlyTerms({ paths: ['/v1/buy', '/v1/other'], paywall }));
  app.post('/v1/buy', (_req, res) => res.json({ bought: true }));
  app.get('/v1/pick', (_req, res) => res.json({ pick: true }));
  return { app, seen };
}

async function call(app, path, { method = 'GET', headers = {} } = {}) {
  const s = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}${path}`, { method, headers });
    return { status: res.status, allow: res.headers.get('allow'), terms: res.headers.get('payment-required'), body: method === 'HEAD' ? '' : await res.text() };
  } finally { s.close(); }
}

test('an unpaid GET or HEAD gets the POST\'s 402, with Allow: POST', async () => {
  const { app, seen } = server();
  const get = await call(app, '/v1/buy?need=x');
  assert.equal(get.status, 402);
  assert.equal(get.terms, 'terms');
  assert.equal(get.allow, 'POST');
  assert.deepEqual(seen, ['POST /v1/buy'], 'the paywall saw the POST the GET stands for');
  const head = await call(app, '/v1/buy/', { method: 'HEAD' });
  assert.equal(head.status, 402);
  assert.equal(head.allow, 'POST');
});

test('a GET with a payment or an MPP credential is refused, without reaching the paywall', async () => {
  for (const headers of [{ 'payment-signature': 'x' }, { 'x-payment': 'x' }, { authorization: 'Payment abc' }]) {
    const { app, seen } = server();
    const r = await call(app, '/v1/buy', { headers });
    assert.equal(r.status, 405);
    assert.equal(r.allow, 'POST');
    assert.match(r.body, /takes POST/);
    assert.deepEqual(seen, []);
  }
});

test('a path the paywall doesn\'t guard gets 405; other routes and POST are untouched', async () => {
  const { app } = server();
  assert.equal((await call(app, '/v1/other')).status, 405);
  assert.equal((await call(app, '/v1/pick')).status, 200);
  assert.equal((await call(app, '/v1/buy', { method: 'POST' })).status, 200);
});

test('a browser\'s GET gets the 402 as JSON, not a paywall page that can\'t pay a POST route', async () => {
  const { app } = server();
  const r = await call(app, '/v1/buy', { headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'Mozilla/5.0' } });
  assert.equal(r.status, 402);
  assert.equal(r.terms, 'terms');
  assert.doesNotMatch(r.body, /window\.x402/);
});
