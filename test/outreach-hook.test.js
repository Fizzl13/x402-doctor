const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutreachHook, recheckFindings } = require('../lib/outreach-hook');

const failing = { overall: 'fail', checks: [{ id: 'bazaar', status: 'fail', message: 'Bazaar declaration is invalid.', hint: 'Add contractType.' }, { id: 'x', status: 'pass', message: 'ok' }] };
function hook({ spec = { info: { contact: { email: 'ops@seller.test' } } }, status = 200 } = {}) {
  const posts = [];
  const safeFetch = async () => ({ status, text: JSON.stringify(spec), truncated: false });
  const fetch = async (u, init) => { posts.push({ u, init, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ draft: { id: 'ow_1' } }), { status: 200 }); };
  return { posts, h: createOutreachHook({ url: 'https://wallet.test', key: 'k', safeFetch, fetch, log: { warn() {}, log() {} } }) };
}

test('a failing check with a published contact becomes one draft request', async () => {
  const { posts, h } = hook();
  assert.deepEqual(await h.maybeDraft('https://api.seller.test/x', failing), { drafted: 'api.seller.test' });
  assert.equal(posts[0].u, 'https://wallet.test/hooks/outreach-draft');
  assert.equal(posts[0].init.headers.authorization, 'Bearer k');
  assert.deepEqual(posts[0].body.findings, [{ id: 'bazaar', message: 'Bazaar declaration is invalid.', hint: 'Add contractType.' }]);
  assert.equal(posts[0].body.to, 'ops@seller.test');
  assert.deepEqual(await h.maybeDraft('https://api.seller.test/y', failing), { skipped: 'already tried today' });
  assert.equal(posts.length, 1);
});

test('no draft: passing check, own host, no contact, or the hook off', async () => {
  const { posts, h } = hook();
  assert.equal((await h.maybeDraft('https://a.test/x', { overall: 'warn', checks: [] })).skipped, 'off_or_not_failing');
  assert.equal((await h.maybeDraft('https://presign-guard.fizzl.eu/v1/check', failing)).skipped, 'own');
  assert.equal((await h.maybeDraft('https://c.test/x', failing, { agent: 'fizzl-monitor/smoke' })).skipped, 'own');
  const none = hook({ spec: { info: {} } });
  assert.match((await none.h.maybeDraft('https://b.test/x', failing)).skipped, /no contact/);
  const off = createOutreachHook({ url: '', key: '', safeFetch: async () => ({}) });
  assert.equal(off.enabled, false);
  assert.equal((await off.maybeDraft('https://c.test/x', failing)).skipped, 'off_or_not_failing');
  assert.equal(posts.length + none.posts.length, 0);
});

test('recheck: a finding is still there when the web check shows it (fail or warn) or the preflight gives it', async () => {
  const diagnose = async () => ({ checks: [{ id: 'resource-url', status: 'warn' }, { id: 'bazaar', status: 'pass' }, { id: 'solana-payout-account', status: 'fail' }] });
  const preflight = async () => ({ reasons: [{ code: 'resource_mismatch' }] });
  const r = await recheckFindings({ url: 'https://a.test/x', ids: ['resource-url', 'bazaar', 'solana-payout-account', 'resource_mismatch', 'price_above_advertised'], diagnose, preflight });
  assert.deepEqual(r.still, ['resource-url', 'solana-payout-account', 'resource_mismatch']);
  assert.deepEqual(r.fixed, ['bazaar', 'price_above_advertised']);
  // One of the two failing is enough to answer; both failing is an error (the wallet server then sends as drafted).
  assert.deepEqual((await recheckFindings({ url: 'https://a.test/x', ids: ['resource_mismatch'], diagnose: async () => { throw new Error('x'); }, preflight })).still, ['resource_mismatch']);
  await assert.rejects(recheckFindings({ url: 'https://a.test/x', ids: ['a'], diagnose: async () => { throw new Error('x'); }, preflight: async () => { throw new Error('y'); } }), /could not check/);
});

test('POST /api/outreach/recheck: only with the outreach key; answers which findings are still there', async (t) => {
  const http = require('node:http');
  const { createApp } = require('../server.js');
  const seller = http.createServer((_req, res) => res.end('free')); // answers 200: no 402 any more
  await new Promise((r) => seller.listen(0, '127.0.0.1', r));
  const deps = { allowPrivate: true, cdpValidate: null, status: { snapshot: async () => ({}) }, outreachHook: { maybeDraft: async () => null } };
  const start = async (env) => { const app = createApp({ env, ...deps }); const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); return s; };
  const off = await start({});
  const on = await start({ OUTREACH_KEY: 'k1' });
  t.after(() => { seller.close(); off.close(); on.close(); });
  const post = (srv, body, key) => fetch(`http://127.0.0.1:${srv.address().port}/api/outreach/recheck`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  const target = `http://127.0.0.1:${seller.address().port}/paid`;
  assert.equal((await post(off, { url: target, ids: ['no_402'] }, 'k1')).status, 404);
  assert.equal((await post(on, { url: target, ids: ['no_402'] }, 'wrong')).status, 401);
  assert.equal((await post(on, { url: target, ids: [] }, 'k1')).status, 400);
  const res = await post(on, { url: target, ids: ['no_402', 'bazaar'] }, 'k1');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual([j.still, j.fixed], [['no_402'], ['bazaar']]);
});
