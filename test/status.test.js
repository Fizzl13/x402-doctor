const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatus } = require('../lib/status');
const { createApp } = require('../server.js');

const services = [
  { id: 'a', name: 'A', what: 'a', home: 'https://a.test/', paid: { url: 'https://a.test/paid' }, track: ['https://a.test/paid', 'https://a-old.test/paid'] },
  { id: 'b', name: 'B', what: 'b', home: 'https://b.test/', paid: { url: 'https://b.test/paid', method: 'POST' }, track: ['https://b.test/paid'] },
  { id: 'w', name: 'W', what: 'w', home: 'https://w.test/', health: 'https://w.test/health', track: [] },
];
const trustIndex = {
  async lookup(url) {
    const days = ['d1', 'd2', 'd3', 'd4'];
    const h = { 'https://a.test/paid': '--gg', 'https://a-old.test/paid': 'gnc-', 'https://b.test/paid': '-gnn' }[url];
    return h ? { history: h, days } : null;
  },
};

test('status: live probes and the daily history per service', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([init.method, url, init.headers['user-agent']]);
    const status = { 'https://a.test/': 200, 'https://a.test/paid': 402, 'https://b.test/': 200, 'https://b.test/paid': 500, 'https://w.test/health': 200 }[url];
    return new Response('', { status });
  };
  let t = 1_000_000;
  const s = createStatus({ trustIndex, fetchImpl, now: () => t, services });
  const snap = await s.snapshot();
  assert.equal(snap.overall, 'degraded');
  const [a, b, w] = snap.services;
  assert.equal(a.now.state, 'up');
  assert.equal(b.now.state, 'degraded');
  assert.match(b.now.note, /HTTP 500 instead of 402/);
  assert.equal(w.now.state, 'up');
  assert.equal(w.history, null);
  // a: old address payable on d1, d3 (caution counts), new address d3, d4; d2 'n' on the old one only.
  assert.deepEqual(a.history.days.map((d) => d.state), ['up', 'down', 'up', 'up']);
  assert.equal(a.history.uptime, 75);
  assert.deepEqual(b.history.days.map((d) => d.state), ['none', 'up', 'down', 'down']);
  assert.ok(calls.some(([m, u]) => m === 'POST' && u === 'https://b.test/paid'));
  assert.ok(calls.every(([, , ua]) => /monitor/.test(ua)), 'probes are labelled as a monitor, so usage logs leave them out');
  // Within 3 minutes the live result is reused; after that it probes again.
  const n = calls.length;
  await s.snapshot();
  assert.equal(calls.length, n);
  t += 4 * 60 * 1000;
  await s.snapshot();
  assert.ok(calls.length > n);
});

test('status: unreachable is down', async () => {
  const s = createStatus({ trustIndex: null, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, services: [services[0]] });
  const snap = await s.snapshot();
  assert.equal(snap.overall, 'down');
  assert.match(snap.services[0].now.note, /Not reachable/);
});

test('GET /api/status, /status, and status.fizzl.eu at the root', async (t) => {
  const status = { snapshot: async () => ({ overall: 'up', services: [] }) };
  const app = createApp({ env: {}, status });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/status`)).json()).overall, 'up');
  assert.match(await (await fetch(`${base}/status`)).text(), /Fizzl status/);
  const viaHost = await new Promise((resolve, reject) => {
    require('node:http').get({ host: '127.0.0.1', port: server.address().port, path: '/', headers: { host: 'status.fizzl.eu' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); }).on('error', reject);
  });
  assert.match(viaHost, /<title>Fizzl status/);
  assert.doesNotMatch(await (await fetch(`${base}/`)).text(), /<title>Fizzl status/);
});

test('GET /sellers: the seller tools page', async (t) => {
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const page = await (await fetch(`http://127.0.0.1:${server.address().port}/sellers`)).text();
  assert.match(page, /For x402 sellers/);
  assert.match(page, /action="\/trust"/);
  assert.match(page, /href="\/settlement"/);
  assert.match(page, /wallet\.fizzl\.eu\/#\/account/);
});
