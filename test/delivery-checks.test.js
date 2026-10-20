// Paid delivery checks (lib/delivery-checks.js, lib/delivery-runner.js, lib/delivery-results.js): the checks
// before payment, the queue only releasing settled jobs, the status route, and which jobs a run buys.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createDelivery, deliveryError, memoryStore, CAP_USD, DAILY_MAX, DELIVERY_EXAMPLE } = require('../lib/delivery-checks');
const { jobsToRun, candidateOf, recordOf } = require('../lib/delivery-runner');
const { createDeliveryResults } = require('../lib/delivery-results');
const { createDispatcher } = require('../lib/delivery-dispatch');

const BASE = 'eip155:8453';
const go = (usd = 0.02, network = BASE) => async () => ({ verdict: 'go', summary: `OK to pay: $${usd}`, recommended_option: 0, options: [{ network, usd }], reasons: [] });

test('before payment: one public https endpoint of someone else, a "go" on Base within the cap, room today', async () => {
  const store = memoryStore();
  const opts = { store, runPreflight: go() };
  assert.match((await deliveryError({ url: 'not a url' }, opts)).error, /valid URL/);
  assert.match((await deliveryError({ url: 'http://a.example/x' }, opts)).error, /https/);
  assert.match((await deliveryError({ url: 'https://presign-guard.fizzl.eu/v1/screen' }, opts)).error, /fizzl\.eu/);
  assert.equal((await deliveryError({ url: DELIVERY_EXAMPLE }, opts)).status, 0, 'the example the route declares passes its own checks');
  assert.match((await deliveryError({ url: ['https://a.example/x', 'https://b.example/y'] }, opts)).error, /one url/);
  assert.match((await deliveryError({ url: 'https://a.example/x', method: 'PUT' }, opts)).error, /GET or POST/);
  for (const bad of [{ url: 'not a url' }, { url: 'http://a.example/x' }, { url: 'https://x402-doctor.fizzl.eu/api/v1/diagnose' }, { url: 'https://a.example/x', method: 'PUT' }]) {
    assert.equal((await deliveryError(bad, opts)).form, true, `${JSON.stringify(bad)} is malformed whatever the endpoint's state`);
  }
  assert.equal((await deliveryError({ url: 'https://a.example/x' }, { store: { ready: false }, runPreflight: go() })).status, 503);

  const noGo = await deliveryError({ url: 'https://a.example/x' }, { store, runPreflight: async () => ({ verdict: 'no_go', summary: 'Do not pay: payout address on the OFAC list', recommended_option: null, options: [], reasons: [{ level: 'no_go', code: 'payto_sanctioned' }] }) });
  assert.equal(noGo.status, 400);
  assert.equal(noGo.form, undefined, "an endpoint that can't be bought now is not a malformed request");
  assert.deepEqual(noGo.preflight, { verdict: 'no_go', reasons: ['payto_sanctioned'] });
  assert.equal((await deliveryError({ url: 'https://a.example/x' }, { store, runPreflight: go(0.02, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') })).status, 400, 'Base only');
  assert.match((await deliveryError({ url: 'https://a.example/x' }, { store, runPreflight: go(0.5) })).error, /at most \$0\.1/);

  const ok = await deliveryError({ url: 'https://a.example/x?q=1', method: 'GET' }, opts);
  assert.deepEqual(ok, { status: 0, url: 'https://a.example/x?q=1', method: 'GET', price_usd: 0.02 });

  for (let i = 0; i < DAILY_MAX; i++) await store.add({ id: `job${String(i).padStart(7, '0')}`, url: 'https://a.example/x', queued_at: new Date().toISOString() });
  assert.equal((await deliveryError({ url: 'https://a.example/x' }, opts)).status, 503, 'the day is full');
});

// A small app with the routes, a stand-in for the x402 middleware (it sets PAYMENT-RESPONSE when told to) and fake
// results from the delivery-data branch.
async function app({ store, settle = true, done = {}, onSettled = null }) {
  const results = { ids: async () => new Set(Object.keys(done)), forId: async (id) => done[id] || null };
  const d = createDelivery({ express, store, results, runPreflight: go(), publicUrl: 'https://doctor.test', onSettled });
  const a = express();
  a.use(d.free);
  a.get('/api/v1/delivery-check', d.validate, (req, res, next) => {
    if (settle) res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, transaction: '0xabc' })).toString('base64'));
    next();
  }, d.order);
  return new Promise((resolve) => {
    const server = http.createServer(a).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

test('a paid order queues the job; only a settled payment releases it to the queue; the status route follows it', async () => {
  const store = memoryStore();
  const started = [];
  const s = await app({ store, onSettled: (job) => started.push(job.id) });
  try {
    const order = await (await fetch(`${s.url}/api/v1/delivery-check?url=${encodeURIComponent('https://a.example/x')}`)).json();
    assert.match(order.id, /^[a-z0-9]{10}$/);
    assert.equal(order.status_url, `https://doctor.test/api/v1/delivery-check/${order.id}`);
    assert.equal(order.endpoint_price_usd, 0.02);
    await new Promise((r) => setTimeout(r, 50)); // the settle mark runs when the answer is finished
    const job = await store.get(order.id);
    assert.equal(job.settled, true);
    assert.equal(job.payment_tx, '0xabc');
    assert.deepEqual(started, [order.id], 'the workflow is started once the job is settled');
    const queue = await (await fetch(`${s.url}/api/v1/delivery-check/queue`)).json();
    assert.equal(queue.cap_usd, CAP_USD);
    assert.deepEqual(queue.jobs.map((j) => j.id), [order.id]);
    const status = await (await fetch(order.status_url.replace('https://doctor.test', s.url))).json();
    assert.equal(status.status, 'queued');
    assert.equal((await fetch(`${s.url}/api/v1/delivery-check/nope`)).status, 404);
    assert.equal((await fetch(`${s.url}/api/v1/delivery-check/abcdefghij`)).status, 404);
  } finally { s.close(); }

  const unsettled = memoryStore();
  const u = await app({ store: unsettled, settle: false, onSettled: (job) => started.push(job.id) });
  try {
    const order = await (await fetch(`${u.url}/api/v1/delivery-check?url=${encodeURIComponent('https://a.example/x')}`)).json();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await unsettled.get(order.id)).settled, false);
    assert.deepEqual((await (await fetch(`${u.url}/api/v1/delivery-check/queue`)).json()).jobs, [], 'not settled, not bought');
    assert.equal((await (await fetch(`${u.url}/api/v1/delivery-check/${order.id}`)).json()).status, 'awaiting_payment');
    assert.equal(started.length, 1, 'no workflow start for a payment that did not settle');
  } finally { u.close(); }
});

test("the workflow start: GitHub's dispatch API with the token, at most one a minute, off without a token", async () => {
  const calls = [];
  let t = 1_000_000;
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return new Response(null, { status: 204 }); };
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  const d = createDispatcher({ token: 'tok', fetchImpl, now: () => t, minGapMs: 40, log });
  assert.equal(d.enabled, true);
  assert.equal(await d.dispatch(), true);
  assert.equal(calls[0].url, 'https://api.github.com/repos/Fizzl13/x402-doctor/actions/workflows/delivery-check.yml/dispatches');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { ref: 'master' });
  // Two more orders within the minute share one later start.
  t += 10;
  const [a, b] = [d.dispatch(), d.dispatch()];
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.equal(await a, true);
  assert.equal(calls.length, 2);
  // A refusal is logged, never thrown: the order still waits for the schedule.
  const bad = createDispatcher({ token: 'tok', fetchImpl: async () => new Response('{}', { status: 403 }), log });
  assert.equal(await bad.dispatch(), false);
  assert.match(errors[0], /HTTP 403/);
  const off = createDispatcher({ token: null, fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(off.enabled, false);
  assert.equal(await off.dispatch(), false);
  assert.deepEqual(await off.verify(), { state: 'off' });
});

test('the token check: reads the workflow without starting it; a refusal shows as failed, GitHub down as unknown', async () => {
  const calls = [];
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  const answers = [new Response('{}', { status: 200 }), new Response('{}', { status: 401 })];
  const d = createDispatcher({ token: 'tok', fetchImpl: async (url, opts = {}) => { calls.push({ url, opts }); return answers.shift(); }, now: () => Date.parse('2026-10-12T20:00:00Z'), log });
  assert.equal(d.status().state, 'checking');
  assert.deepEqual(await d.verify(), { state: 'ok', checked_at: '2026-10-12T20:00:00.000Z' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/Fizzl13/x402-doctor/actions/workflows/delivery-check.yml');
  assert.equal(calls[0].opts.method, undefined, 'a GET: nothing is started');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer tok');
  assert.equal((await d.verify()).state, 'failed');
  assert.equal(d.status().error, 'HTTP 401');
  assert.match(errors[0], /DELIVERY_DISPATCH_TOKEN does not work \(HTTP 401\)/);
  const down = createDispatcher({ token: 'tok', fetchImpl: async () => { throw new Error('network down'); }, log });
  assert.equal((await down.verify()).state, 'unknown');
});

test('a done job leaves the queue and shows its result', async () => {
  const store = memoryStore();
  await store.add({ id: 'aaaaaaaaaa', url: 'https://a.example/x', method: null, price_usd: 0.02, queued_at: '2026-10-12T17:00:00.000Z', settled: true });
  await store.add({ id: 'bbbbbbbbbb', url: 'https://b.example/y', method: null, price_usd: 0.01, queued_at: '2026-10-12T17:05:00.000Z', settled: true });
  const result = { id: 'aaaaaaaaaa', url: 'https://a.example/x', result: 'delivered', paid_and_delivered: true, charged_usd: 0.02 };
  const s = await app({ store, done: { aaaaaaaaaa: result } });
  try {
    assert.deepEqual((await (await fetch(`${s.url}/api/v1/delivery-check/queue`)).json()).jobs.map((j) => j.id), ['bbbbbbbbbb']);
    const status = await (await fetch(`${s.url}/api/v1/delivery-check/aaaaaaaaaa`)).json();
    assert.equal(status.status, 'done');
    assert.deepEqual(status.result, result);
  } finally { s.close(); }
});

test('a run buys queued jobs not done yet, oldest first, within 5 a run and the daily limit', () => {
  const now = Date.parse('2026-10-12T18:00:00Z');
  const job = (id, min, url = `https://${id}.example/x`) => ({ id, url, queued_at: new Date(now - min * 60e3).toISOString() });
  const queue = { jobs: [job('cccccccccc', 1), job('aaaaaaaaaa', 30), job('bbbbbbbbbb', 20), job('dddddddddd', 5, 'https://x.fizzl.eu/y'), job('bad', 2), job('eeeeeeeeee', 3), job('ffffffffff', 4), job('gggggggggg', 6)] };
  assert.deepEqual(jobsToRun(queue, { results: {} }, { now }).map((j) => j.id), ['aaaaaaaaaa', 'bbbbbbbbbb', 'gggggggggg', 'ffffffffff', 'eeeeeeeeee']);
  assert.deepEqual(jobsToRun(queue, { results: { aaaaaaaaaa: { date: '2026-10-11T10:00:00Z', step: 'paid' } } }, { now }).map((j) => j.id)[0], 'bbbbbbbbbb', 'done jobs are skipped');
  const today = Object.fromEntries(Array.from({ length: DAILY_MAX - 1 }, (_, i) => [`t${i}`, { date: '2026-10-12T09:00:00Z', step: 'paid' }]));
  assert.equal(jobsToRun(queue, { results: today }, { now }).length, 1, 'one left today');
  assert.equal(candidateOf({ url: 'http://a.example/x' }), null);
  assert.equal(candidateOf({ url: 'https://u:p@a.example/x' }), null);
  assert.deepEqual(candidateOf({ url: 'https://A.example/x', method: 'POST' }), { url: 'https://a.example/x', host: 'a.example', method: 'POST', price_usd: null });
});

test('what is published for a purchase', () => {
  const r = { result: 'delivered', step: 'paid', status: 200, price_usd: 0.02, charged_usd: 0.02, request: { method: 'GET', url: 'https://a.example/x?q=1', source: 'example' }, proof: { transaction: '0xabc', explorer: 'https://basescan.org/tx/0xabc' }, cache: { cache_control: 'public, max-age=60', shared_cache: 'yes' } };
  const rec = recordOf({ id: 'aaaaaaaaaa', url: 'https://a.example/x', queued_at: '2026-10-12T17:00:00.000Z' }, r, '2026-10-12T17:12:00.000Z');
  assert.equal(rec.paid_and_delivered, true);
  assert.deepEqual(rec.request, { method: 'GET', source: 'example' });
  assert.equal(rec.explorer, 'https://basescan.org/tx/0xabc');
  assert.equal(rec.cap_usd, CAP_USD);
  assert.deepEqual(rec.cache, { cache_control: 'public, max-age=60', shared_cache: 'yes' }, 'whether a CDN could serve the paid answer for free');
  assert.equal(recordOf({ id: 'bbbbbbbbbb', url: 'https://b.example/y' }, { result: 'not_go_now', step: 'preflight', preflight: { verdict: 'caution', codes: ['x'] } }).paid_and_delivered, false);
});

test('results from the delivery-data branch: by id, the newest per endpoint, and none before the first run', async () => {
  const index = { results: {
    aaaaaaaaaa: { id: 'aaaaaaaaaa', url: 'https://a.example/x', date: '2026-10-12T10:00:00Z', result: 'error_not_charged' },
    bbbbbbbbbb: { id: 'bbbbbbbbbb', url: 'https://a.example/x', date: '2026-10-12T12:00:00Z', result: 'delivered' },
  } };
  const r = createDeliveryResults({ url: 'https://raw.test/index.json', fetchImpl: async () => Response.json(index) });
  assert.equal((await r.forId('aaaaaaaaaa', { waitMs: 1000 })).result, 'error_not_charged');
  assert.equal((await r.forUrl('https://a.example/x')).result, 'delivered');
  assert.deepEqual([...(await r.ids())].sort(), ['aaaaaaaaaa', 'bbbbbbbbbb']);
  const none = createDeliveryResults({ url: 'https://raw.test/index.json', fetchImpl: async () => new Response('Not Found', { status: 404 }) });
  assert.equal((await none.ids({ waitMs: 1000 })).size, 0);
});

test('the Redis store (a stand-in client): add, settle mark, list newest first, today\'s count', async () => {
  const kv = new Map(); const z = new Map();
  const fake = () => ({
    on() {}, async connect() {},
    async set(k, v, opts) { if (opts && !opts.EX && !opts.KEEPTTL) throw new Error('unexpected options'); kv.set(k, v); },
    async get(k) { return kv.get(k) ?? null; },
    async mGet(keys) { return keys.map((k) => kv.get(k) ?? null); },
    async incr(k) { kv.set(k, String(Number(kv.get(k) || 0) + 1)); },
    async expire() {},
    async zAdd(k, { score, value }) { z.set(value, score); },
    async zRemRangeByScore(_k, min, max) { for (const [v, s] of z) if (s >= min && s <= max) z.delete(v); },
    async zRange(_k, a, b, opts) { const ids = [...z.entries()].sort((x, y) => (opts?.REV ? y[1] - x[1] : x[1] - y[1])).map(([v]) => v); return ids.slice(a, b + 1); },
  });
  const { redisStore } = require('../lib/delivery-checks');
  const store = redisStore('redis://localhost:6379', { connect: fake, log: { warn() {} } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.ready, true);
  const t = Date.now();
  await store.add({ id: 'aaaaaaaaaa', url: 'https://a.example/x', queued_at: new Date(t - 60e3).toISOString(), settled: false });
  await store.add({ id: 'bbbbbbbbbb', url: 'https://b.example/y', queued_at: new Date(t).toISOString(), settled: false });
  await store.update('aaaaaaaaaa', { settled: true, payment_tx: '0xabc' });
  assert.equal((await store.get('aaaaaaaaaa')).payment_tx, '0xabc');
  assert.deepEqual((await store.list()).map((j) => j.id), ['bbbbbbbbbb', 'aaaaaaaaaa']);
  assert.equal(await store.countToday(), 2);
  assert.equal(redisStore('not a url').ready, false);
});

test('a probe without payment gets its 402 within the time budget; a paid request waits for the whole check', async () => {
  // The CDP Bazaar validator and health probe give up after 10 s; a fresh pre-payment check can take longer.
  const slowNoGo = () => new Promise((resolve) => setTimeout(resolve, 300, { verdict: 'no_go', summary: 'Do not pay', recommended_option: null, options: [], reasons: [] }));
  const d = createDelivery({ express, store: memoryStore(), results: null, runPreflight: slowNoGo, probeBudgetMs: 50 });
  const call = (headers = {}) => new Promise((resolve) => {
    const req = { query: { url: 'https://a.example/x' }, ip: '1.2.3.4', get: (name) => headers[name.toLowerCase()] };
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    const started = Date.now();
    d.validate(req, res, () => resolve({ code: 'next', job: req.deliveryJob, ms: Date.now() - started }));
  });
  const probe = await call();
  assert.equal(probe.code, 'next', 'on to the 402');
  assert.equal(probe.job, undefined, 'nothing to order without the whole check');
  assert.ok(probe.ms < 250, `answered in ${probe.ms} ms`);
  assert.equal((await call({ 'payment-signature': 'eyJ4' })).code, 400, 'with a payment the whole check runs, and refuses before anything settles');
  assert.equal((await call({ authorization: 'Payment abc' })).code, 400, 'an MPP credential counts as a payment too');
  const fast = createDelivery({ express, store: memoryStore(), results: null, runPreflight: go(), probeBudgetMs: 50 });
  const fastProbe = await new Promise((resolve) => {
    const req = { query: { url: 'https://a.example/x' }, ip: '1.2.3.5', get: () => undefined };
    fast.validate(req, { status() { return this; }, json: resolve }, () => resolve({ next: true, job: req.deliveryJob }));
  });
  assert.equal(fastProbe.job.price_usd, 0.02, 'a check that finishes in time still runs before the 402');
});

test('a probe without payment gets the 402 for an endpoint that cannot be bought now; only a malformed request is refused first', async () => {
  // Uptime monitors fill the required url with a placeholder (https://example.com, no 402 there) and count anything
  // but a 402 as the route being down. The buyer is still protected: with a payment the same request is refused
  // before anything settles.
  const noGo = async () => ({ verdict: 'no_go', summary: 'Do not pay: no 402', recommended_option: null, options: [], reasons: [{ level: 'no_go', code: 'no_402' }] });
  const d = createDelivery({ express, store: memoryStore(), results: null, runPreflight: noGo });
  const call = (url, headers = {}) => new Promise((resolve) => {
    const req = { query: { url }, ip: '1.2.3.6', get: (name) => headers[name.toLowerCase()] };
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    d.validate(req, res, () => resolve({ code: 'next', job: req.deliveryJob }));
  });
  assert.deepEqual(await call('https://example.com'), { code: 'next', job: undefined }, 'on to the 402, nothing to order');
  const paid = await call('https://example.com', { 'payment-signature': 'eyJ4' });
  assert.equal(paid.code, 400);
  assert.deepEqual(paid.body.preflight, { verdict: 'no_go', reasons: ['no_402'] });
  assert.equal((await call('http://example.com')).code, 400, 'a malformed request is answered without payment too');
  assert.equal((await call('https://example.com', { 'x-delivery-precheck': '1' })).code, 400, 'asked for, the answer comes before any payment (the homepage asks)');
  const down = createDelivery({ express, store: { ready: false }, results: null, runPreflight: noGo });
  const busy = await new Promise((resolve) => {
    const req = { query: { url: 'https://a.example/x' }, ip: '1.2.3.7', get: () => undefined };
    down.validate(req, { status() { return this; }, json: resolve }, () => resolve('next'));
  });
  assert.equal(busy, 'next', 'a store that is down still shows the 402 to a probe');
});

test('the check before payment is rate-limited per caller; a probe over the limit still gets the 402', async () => {
  const d = createDelivery({ express, store: memoryStore(), results: null, runPreflight: go(), checksPerHour: 2 });
  const call = (headers = {}) => new Promise((resolve) => {
    const req = { query: { url: 'https://a.example/x' }, ip: '1.2.3.4', get: (name) => headers[name.toLowerCase()] };
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    d.validate(req, res, () => resolve({ code: 'next', job: req.deliveryJob }));
  });
  assert.equal((await call()).job.price_usd, 0.02);
  assert.equal((await call()).job.price_usd, 0.02);
  assert.deepEqual(await call(), { code: 'next', job: undefined }, 'over the limit: no check, on to the 402');
  assert.equal((await call({ 'payment-signature': 'eyJ4' })).code, 429, 'a paid request over the limit is refused before it settles');
});

test('the same dispatcher starts the hourly on-chain count; a refusal names that workflow', async () => {
  const calls = [];
  const errors = [];
  const d = createDispatcher({ token: 'tok', workflow: 'onchain-payments.yml', waits: 'the hourly schedule is the fallback', fetchImpl: async (url, opts) => (calls.push({ url, opts }), new Response(null, { status: 204 })), log: { error: (m) => errors.push(m) } });
  assert.equal(await d.dispatch(), true);
  assert.equal(calls[0].url, 'https://api.github.com/repos/Fizzl13/x402-doctor/actions/workflows/onchain-payments.yml/dispatches');
  const bad = createDispatcher({ token: 'tok', workflow: 'onchain-payments.yml', waits: 'the hourly schedule is the fallback', fetchImpl: async () => new Response('{}', { status: 403 }), log: { error: (m) => errors.push(m) } });
  assert.equal(await bad.dispatch(), false);
  assert.match(errors[0], /onchain-payments\.yml \(HTTP 403\); the hourly schedule is the fallback/);
});
