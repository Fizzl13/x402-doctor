// The refusal extension (lib/refusal.js, draft x402-foundation/x402#4087): the shared pieces, the seller endpoint and
// Doctor's own 402 naming it.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { canonical, offerHash, refusalExtension, refusalTarget, refusalReport, parseRefusal, signingMessage, createRefusalRoutes, PATH } = require('../lib/refusal');

const ACCEPT = { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } };
const servers = [];
test.after(() => servers.forEach((s) => s.close()));

test('offer hash: canonical JSON, the same whatever the key order', () => {
  const shuffled = { extra: { version: '2', name: 'USD Coin' }, payTo: ACCEPT.payTo, maxTimeoutSeconds: 60, amount: '10000', asset: ACCEPT.asset, network: ACCEPT.network, scheme: 'exact' };
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 'x' }] }), '{"a":[2,{"c":"x","d":1}],"b":1}');
  assert.equal(offerHash(shuffled), offerHash(ACCEPT));
  assert.match(offerHash(ACCEPT), /^[0-9a-f]{64}$/);
  assert.notEqual(offerHash({ ...ACCEPT, amount: '10001' }), offerHash(ACCEPT));
});

test('target: only an https url on the resource\'s own site', () => {
  const ch = (url) => ({ extensions: { refusal: { info: { url } } } });
  assert.equal(refusalTarget(ch('https://api.seller.com/.well-known/x402-refusal'), 'https://api.seller.com/paid'), 'https://api.seller.com/.well-known/x402-refusal');
  assert.equal(refusalTarget(ch('https://hooks.seller.com/r'), 'https://api.seller.com/paid'), 'https://hooks.seller.com/r', 'same site');
  assert.equal(refusalTarget(ch('https://victim.example/r'), 'https://api.seller.com/paid'), null, 'someone else\'s server');
  assert.equal(refusalTarget(ch('http://api.seller.com/r'), 'https://api.seller.com/paid'), null, 'not https');
  assert.equal(refusalTarget({}, 'https://api.seller.com/paid'), null);
  assert.equal(refusalTarget(ch('https://victim.onrender.com/r'), 'https://seller.onrender.com/paid'), null, 'shared hosting: only the exact host');
  assert.equal(refusalTarget(ch('https://seller.onrender.com/r'), 'https://seller.onrender.com/paid'), 'https://seller.onrender.com/r');
});

test('extension entry: small, with the url and the required fields', () => {
  const e = refusalExtension('https://x402-doctor.fizzl.eu/');
  assert.equal(e.refusal.info.url, 'https://x402-doctor.fizzl.eu/.well-known/x402-refusal');
  assert.deepEqual(e.refusal.schema.required, ['x402Version', 'resource', 'offer', 'reason', 'checkedAt']);
  assert.ok(JSON.stringify(e).length < 400, '402 headers are size-limited');
});

test('parse: a buyer\'s report passes; bad fields, old reports and other sellers\' resources do not', () => {
  const report = refusalReport({ resource: 'https://x402-doctor.fizzl.eu/api/v1/preflight', accept: ACCEPT, acceptIndex: 0, reason: 'price_above_limit', detail: 'per_call', by: 'test' });
  assert.ok(parseRefusal(report, { ownHost: 'x402-doctor.fizzl.eu' }).report);
  // 0.4: no limits, budgets or amounts in a policy reason's detail; price_above_limit's is a category.
  assert.throws(() => refusalReport({ resource: 'x', accept: ACCEPT, reason: 'price_above_limit', detail: 'limit $0.005' }), /which limit/);
  assert.throws(() => refusalReport({ resource: 'x', accept: ACCEPT, reason: 'policy_blocked', detail: 'daily budget 5 USDC' }), /must not contain/);
  assert.ok(refusalReport({ resource: 'x', accept: ACCEPT, reason: 'policy_blocked', detail: 'seller not on the allow list' }));
  assert.ok(refusalReport({ resource: 'x', accept: ACCEPT, reason: 'network_unsupported', detail: 'pays USDC on Base only' }));
  assert.throws(() => refusalReport({ resource: 'x', accept: ACCEPT, reason: 'nope' }));
  const bad = (patch) => parseRefusal({ ...report, ...patch }, { ownHost: 'x402-doctor.fizzl.eu' }).error;
  assert.match(bad({ reason: 'cheaper_elsewhere' }), /reason must be one of/);
  assert.match(bad({ offer: { hash: 'abc' } }), /offer.hash/);
  assert.match(bad({ checkedAt: '2020-01-01T00:00:00Z' }), /within a day/);
  assert.match(bad({ detail: 'x'.repeat(201) }), /detail/);
  assert.match(bad({ resource: 'https://other.example/paid' }), /not a resource of/);
  assert.match(bad({ x402Version: '2' }), /x402Version/);
  assert.match(bad({ detail: 'limit $0.005' }), /which limit/);
  assert.match(bad({ reason: 'trust_low', detail: 'score below max 0.7' }), /must not contain/);
});

async function app(opts = {}) {
  const recorded = [];
  const routes = createRefusalRoutes({ publicUrl: 'https://x402-doctor.fizzl.eu', routes: ['/api/v1/preflight'], record: (r, m) => recorded.push({ r, m }), ...opts });
  const a = express();
  a.set('trust proxy', 1); // as behind Render: the address is the one its proxy hop supplies
  a.use(express.json());
  a.get(PATH, routes.get);
  a.post(PATH, routes.post);
  const s = await new Promise((ok) => { const x = a.listen(0, '127.0.0.1', () => ok(x)); });
  servers.push(s);
  const url = `http://127.0.0.1:${s.address().port}${PATH}`;
  // `from`: the sending address, as the proxy hop would supply it (unsigned reports count once per address a day).
  const post = (body, from) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(from ? { 'x-forwarded-for': from } : {}) }, body: JSON.stringify(body) });
  return { url, post, recorded };
}

test('endpoint: takes a report (204), counts it, checks a signature, and limits each address', async () => {
  const { url, post, recorded } = await app({ perHour: 3 });
  const report = refusalReport({ resource: 'https://x402-doctor.fizzl.eu/api/v1/preflight', accept: ACCEPT, reason: 'payto_changed' });
  assert.equal((await post(report)).status, 204);
  assert.equal(recorded[0].m.signer, null);

  const account = privateKeyToAccount(generatePrivateKey());
  const signed = { ...report, reason: 'price_above_limit' };
  signed.signature = { type: 'eip191', signer: account.address, value: await account.signMessage({ message: signingMessage(signed) }) };
  assert.equal((await post(signed)).status, 204);
  assert.equal(recorded[1].m.signer, account.address.toLowerCase());
  const forged = { ...signed, reason: 'screening_hit' }; // the signature was for another reason
  const r = await post(forged);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /signature/);

  const info = await (await fetch(url)).json();
  assert.equal(info.extension, 'refusal');
  assert.ok(info.reasons.terms_mismatch);
  assert.deepEqual(info.received.by_resource['/api/v1/preflight'], { total: 2, signed: 1, reasons: { payto_changed: 1, price_above_limit: 1 } });
  assert.equal((await post(report)).status, 429, 'three an hour per address (the refused forgery counts too)');
});

test('Doctor\'s own 402 names the refusal endpoint, and the endpoint answers', async () => {
  process.env.BASE_RPC_URL = 'http://127.0.0.1:1';
  const fac = express();
  fac.get('/supported', (_req, res) => res.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: {} }));
  const f = await new Promise((ok) => { const x = fac.listen(0, '127.0.0.1', () => ok(x)); });
  servers.push(f);
  const { createApp } = require('../server');
  const a = createApp({ allowPrivate: true, env: { AGENT_PAYOUT_WALLET: ACCEPT.payTo, FACILITATOR_URL: `http://127.0.0.1:${f.address().port}` }, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, creditStore: null, vaultStore: null });
  const s = await new Promise((ok) => { const x = a.listen(0, '127.0.0.1', () => ok(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${s.address().port}`;
  const res = await fetch(`${base}/api/v1/preflight?url=https://example.com/paid`);
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString());
  assert.equal(challenge.extensions.refusal.info.url, 'https://x402-doctor.fizzl.eu/.well-known/x402-refusal');
  const report = refusalReport({ resource: 'https://x402-doctor.fizzl.eu/api/v1/preflight', accept: challenge.accepts[0], acceptIndex: 0, reason: 'network_unsupported' });
  const posted = await fetch(`${base}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
  assert.equal(posted.status, 204);
  const info = await (await fetch(`${base}${PATH}`)).json();
  assert.equal(info.received.by_resource['/api/v1/preflight'].reasons.network_unsupported, 1);
});

test('sender: posts the ready report, refuses redirects, and never throws', async () => {
  const { createRefusalSender } = require('../lib/refusal');
  const calls = [];
  const ok = createRefusalSender({ fetchImpl: async (u, o) => { calls.push({ u, o }); return { status: 204 }; }, by: 'me/1' });
  const refusal = { url: 'https://s.example/r', report: refusalReport({ resource: 'https://s.example/paid', accept: ACCEPT, reason: 'payto_changed' }) };
  assert.equal(await ok.send(refusal), true);
  assert.equal(calls[0].o.redirect, 'error');
  assert.equal(JSON.parse(calls[0].o.body).by, 'me/1');
  assert.equal(await ok.send(refusal), false, 'once a day per resource and reason');
  const down = createRefusalSender({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, log: { warn() {} } });
  assert.equal(await down.send(refusal), false);
  assert.equal(await down.send(null), false);
});

test('Fizzl Buy\'s own 402 names its refusal endpoint, which takes reports', async () => {
  const { routesFor, createBuyApp } = require('../buy-server');
  const route = routesFor({ AGENT_PAYOUT_WALLET: ACCEPT.payTo })['POST /v1/buy'];
  assert.equal(route.extensions.refusal.info.url, 'https://buy.fizzl.eu/.well-known/x402-refusal');
  const a = createBuyApp({ env: { PUBLIC_URL: 'https://buy.fizzl.eu' }, deps: { usageLog: { middleware: () => (_q, _s, n) => n() }, vaultStore: null, sanctions: null, trustIndex: null, lure: null, wallet: null } });
  const s = await new Promise((ok) => { const x = a.listen(0, '127.0.0.1', () => ok(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${s.address().port}`;
  const report = refusalReport({ resource: 'https://buy.fizzl.eu/v1/buy', accept: ACCEPT, reason: 'price_above_limit' });
  assert.equal((await fetch(`${base}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) })).status, 204);
  const info = await (await fetch(`${base}${PATH}`)).json();
  assert.equal(info.received.by_resource['/v1/buy'].reasons.price_above_limit, 1);
});

test('v0.3: check_unavailable says which check could not complete, and needs that detail', async () => {
  const { UNAVAILABLE_CHECKS, VERSION, REASONS, SIGNED_ONLY, REPORT_SCHEMA } = require('../lib/refusal');
  assert.equal(VERSION, '0.4-draft');
  assert.deepEqual(UNAVAILABLE_CHECKS, ['payto_binding', 'screening', 'trust']);
  assert.ok(REASONS.check_unavailable);
  assert.match(REASONS.payto_unverified, /checked and found nothing/);
  const t = Date.parse('2026-11-02T08:00:00Z');
  const resource = 'https://seller.example/api/data';
  // A ready report: the detail must start with the check.
  assert.throws(() => refusalReport({ resource, accept: ACCEPT, reason: 'check_unavailable', now: new Date(t) }), /detail/);
  assert.throws(() => refusalReport({ resource, accept: ACCEPT, reason: 'check_unavailable', detail: 'screening_hit', now: new Date(t) }), /detail/);
  const ok = refusalReport({ resource, accept: ACCEPT, reason: 'check_unavailable', detail: 'screening: sanctions list not loaded', now: new Date(t) });
  assert.equal(parseRefusal(ok, { ownHost: 'seller.example', now: t }).report.detail, 'screening: sanctions list not loaded');
  for (const detail of ['payto_binding', 'trust (lookup timed out)']) assert.ok(parseRefusal({ ...ok, detail }, { ownHost: 'seller.example', now: t }).report, detail);
  // Received without the check named, or with something else: refused.
  for (const detail of [undefined, 'lookup failed', 'trustworthy', 'screening_hit']) assert.match(parseRefusal({ ...ok, detail }, { ownHost: 'seller.example', now: t }).error, /check_unavailable/, String(detail));
  // The schema says the same.
  const rule = REPORT_SCHEMA.allOf.find((r) => r.if.properties.reason.const === 'check_unavailable');
  assert.deepEqual(rule.then.required, ['detail']);
  assert.ok(new RegExp(rule.then.properties.detail.pattern).test('payto_binding'));
  // Unsigned and taken, like any reason but screening_hit.
  assert.ok(!SIGNED_ONLY.has('check_unavailable'));
});

test('v0.2: trust_low, a screening_hit only when signed, and counts per day', async () => {
  const { REASONS, FROM_PREFLIGHT, SIGNED_ONLY, REPORT_SCHEMA, createRefusalSender, VERSION } = require('../lib/refusal');
  assert.ok(REASONS.trust_low);
  assert.equal(FROM_PREFLIGHT.unreliable_history, 'trust_low');
  assert.equal(FROM_PREFLIGHT.charged_without_answer, 'trust_low');
  assert.deepEqual([...SIGNED_ONLY], ['screening_hit']);
  assert.deepEqual(REPORT_SCHEMA.allOf[0].then.required, ['signature']);

  let t = Date.parse('2026-11-01T10:00:00Z');
  const { url, post } = await app({ perHour: 10, now: () => t });
  const resource = 'https://x402-doctor.fizzl.eu/api/v1/preflight';
  const unsigned = refusalReport({ resource, accept: ACCEPT, reason: 'screening_hit', now: new Date(t) });
  const r = await post(unsigned);
  assert.equal(r.status, 400, 'an unsigned screening_hit could flag any seller');
  assert.match((await r.json()).error, /must be signed/);
  const account = privateKeyToAccount(generatePrivateKey());
  const signed = { ...unsigned, signature: { type: 'eip191', signer: account.address, value: await account.signMessage({ message: signingMessage(unsigned) }) } };
  assert.equal((await post(signed)).status, 204);

  assert.equal((await post(refusalReport({ resource, accept: ACCEPT, reason: 'trust_low', detail: 'unknown', now: new Date(t) }))).status, 204);
  t += 86400 * 1000;
  assert.equal((await post(refusalReport({ resource, accept: ACCEPT, reason: 'trust_low', detail: 'score', now: new Date(t) }))).status, 204);
  assert.equal((await post(refusalReport({ resource, accept: ACCEPT, reason: 'trust_low', now: new Date(t) }), '203.0.113.2')).status, 204);
  const info = await (await fetch(url)).json();
  assert.equal(info.version, VERSION);
  assert.deepEqual(info.received.by_day, [
    { day: '2026-11-02', resource: '/api/v1/preflight', reason: 'trust_low', count: 2, signed: 0 },
    { day: '2026-11-01', resource: '/api/v1/preflight', reason: 'screening_hit', count: 1, signed: 1 },
    { day: '2026-11-01', resource: '/api/v1/preflight', reason: 'trust_low', count: 1, signed: 0 },
  ]);

  // A buyer's sender doesn't post a screening_hit it can't sign (the seller would refuse it).
  const calls = [];
  const sender = createRefusalSender({ fetchImpl: async () => { calls.push(1); return { status: 204 }; } });
  assert.equal(await sender.send({ url: 'https://s.example/r', report: refusalReport({ resource: 'https://s.example/paid', accept: ACCEPT, reason: 'screening_hit' }) }), false);
  assert.equal(calls.length, 0);
});

test('a report counts under the route the seller declares: no query or path from the buyer shows up, and a repost counts once', async () => {
  const { url, post, recorded } = await app({ routes: ['/api/v1/preflight', '/v1/items/:id'] });
  const markers = ['marker-a-7f3c', 'marker-b-91e2', 'item-55d0', 'item-c4a8', 'stray-0b6e'];
  const reports = [
    refusalReport({ resource: `https://x402-doctor.fizzl.eu/api/v1/preflight?url=https://${markers[0]}.example/x`, accept: ACCEPT, reason: 'price_above_limit' }),
    refusalReport({ resource: `https://x402-doctor.fizzl.eu/api/v1/preflight/?email=${markers[1]}`, accept: ACCEPT, reason: 'price_above_limit' }),
    refusalReport({ resource: `https://x402-doctor.fizzl.eu/v1/items/${markers[2]}`, accept: ACCEPT, reason: 'payto_changed' }),
    refusalReport({ resource: `https://x402-doctor.fizzl.eu/v1/items/${markers[3]}?q=1`, accept: ACCEPT, reason: 'payto_changed' }),
    refusalReport({ resource: `https://x402-doctor.fizzl.eu/${markers[4]}/deep/path`, accept: ACCEPT, reason: 'payto_changed' }),
  ];
  for (const [i, r] of reports.entries()) assert.equal((await post(r, `203.0.113.${i + 1}`)).status, 204);
  assert.equal((await post(reports[0], '203.0.113.1')).status, 204, 'an exact repost is taken');

  const text = await (await fetch(url)).text();
  const info = JSON.parse(text);
  assert.deepEqual(Object.keys(info.received.by_resource).sort(), ['/api/v1/preflight', '/v1/items/:id', 'other']);
  assert.equal(info.received.by_resource['/api/v1/preflight'].total, 2, 'two inputs to one route, one bucket; the repost counts once');
  assert.equal(info.received.by_resource['/v1/items/:id'].total, 2);
  assert.equal(info.received.by_resource.other.total, 1);
  const kept = JSON.stringify(recorded.map((x) => x.r));
  for (const m of markers) {
    assert.ok(!text.includes(m), `${m} is not in the public counts`);
    assert.ok(!kept.includes(m), `${m} is not passed to the record hook`);
  }
  assert.equal(recorded.length, 5);
});

test('unsigned reports are capped: one per sending address, UTC day, route and reason, whatever their checkedAt (Lucian)', async () => {
  let t = Date.parse('2026-11-10T08:00:00Z');
  const { url, post, recorded } = await app({ perHour: 30, now: () => t });
  const resource = 'https://x402-doctor.fizzl.eu/api/v1/preflight';
  const at = (min, extra = {}) => refusalReport({ resource, accept: ACCEPT, reason: 'trust_low', now: new Date(t + min * 60000), ...extra });
  // One address varies checkedAt, detail and the URL's query: one contribution.
  for (let i = 0; i < 10; i++) assert.equal((await post(at(i, { detail: i % 2 ? 'score' : 'unknown' }), '198.51.100.7')).status, 204);
  assert.equal((await post(refusalReport({ resource: `${resource}?url=https://a.example/${t}`, accept: ACCEPT, reason: 'trust_low', now: new Date(t) }), '198.51.100.7')).status, 204);
  const count = async () => (await (await fetch(url)).json()).received.by_resource['/api/v1/preflight'];
  assert.deepEqual(await count(), { total: 1, signed: 0, reasons: { trust_low: 1 } });
  // The same address with another reason, and another address with the same reason, each count.
  assert.equal((await post(at(11, { reason: 'price_above_limit' }), '198.51.100.7')).status, 204);
  assert.equal((await post(at(12), '198.51.100.8')).status, 204);
  assert.deepEqual(await count(), { total: 3, signed: 0, reasons: { trust_low: 2, price_above_limit: 1 } });
  // Signed reports are counted apart, once per exact report (a signature proves a key, not a unique customer).
  const account = privateKeyToAccount(generatePrivateKey());
  for (const min of [13, 14]) {
    const r = at(min);
    r.signature = { type: 'eip191', signer: account.address, value: await account.signMessage({ message: signingMessage(r) }) };
    assert.equal((await post(r, '198.51.100.7')).status, 204);
    assert.equal((await post(r, '198.51.100.7')).status, 204, 'its exact repost is taken, not counted');
  }
  assert.deepEqual(await count(), { total: 5, signed: 2, reasons: { trust_low: 4, price_above_limit: 1 } });
  assert.equal(recorded.length, 5, 'only counted reports reach the record hook');
  // A new server day counts the address again; the GET says how unsigned reports are counted.
  t += 86400 * 1000;
  assert.equal((await post(at(0), '198.51.100.7')).status, 204);
  const info = await (await fetch(url)).json();
  assert.equal(info.received.by_day.find((d) => d.day === '2026-11-11').count, 1);
  assert.match(info.received.counted_by, /capped at one per sending address, UTC day, route and reason/);
  assert.ok(!JSON.stringify(info).includes('198.51.100'), 'no address in the public counts');
});

test('basis: a payout or price refusal says what it compared with (live read or catalog), and sellers count them apart', async () => {
  const resource = 'https://x402-doctor.fizzl.eu/api/v1/preflight';
  const live = refusalReport({ resource, accept: ACCEPT, reason: 'payto_changed', basis: { source: 'live', at: '2026-11-09' } });
  assert.deepEqual(live.basis, { source: 'live', at: '2026-11-09' });
  assert.match(signingMessage(live), /\nbasis: live 2026-11-09$/);
  const plain = refusalReport({ resource, accept: ACCEPT, reason: 'payto_changed' });
  assert.equal(plain.basis, undefined);
  assert.doesNotMatch(signingMessage(plain), /basis/, 'without a basis a report signs exactly as before');
  assert.throws(() => refusalReport({ resource, accept: ACCEPT, reason: 'network_unsupported', basis: { source: 'live', at: '2026-11-09' } }), /only for a comparison reason/);
  assert.throws(() => refusalReport({ resource, accept: ACCEPT, reason: 'price_changed', basis: { source: 'rumour', at: '2026-11-09' } }), /basis must be/);
  const bad = (basis, reason = 'payto_changed') => parseRefusal({ ...plain, reason, basis }, { ownHost: 'x402-doctor.fizzl.eu' }).error;
  assert.equal(bad({ source: 'catalog', at: '2026-11-02T08:00:00Z' }), undefined);
  assert.match(bad({ source: 'catalog', at: 'last week' }), /basis must be/);
  assert.match(bad('live'), /basis must be/);
  assert.match(bad({ source: 'live', at: '2026-11-09' }, 'trust_low'), /only for a comparison reason/);

  const { url, post, recorded } = await app();
  assert.equal((await post(live, '203.0.113.1')).status, 204);
  const catalog = refusalReport({ resource, accept: ACCEPT, reason: 'payto_changed', basis: { source: 'catalog', at: '2026-11-02' } });
  assert.equal((await post(catalog, '203.0.113.2')).status, 204);
  assert.equal((await post(plain, '203.0.113.3')).status, 204);
  assert.deepEqual(recorded[1].r.basis, { source: 'catalog', at: '2026-11-02' });
  const info = await (await fetch(url)).json();
  assert.deepEqual(info.received.by_resource['/api/v1/preflight'], { total: 3, signed: 0, reasons: { payto_changed: 3 }, basis: { payto_changed: { live: 1, catalog: 1 } } });
  assert.ok(info.schema.properties.basis);
});

test('basis listed_updated: a catalog comparison can say how old the listing was, next to when it was read', async () => {
  const resource = 'https://x402-doctor.fizzl.eu/api/v1/preflight';
  const basis = { source: 'catalog', at: '2026-11-09T21:00:00Z', listed_updated: '2026-10-31T08:12:00Z' };
  const r = refusalReport({ resource, accept: ACCEPT, reason: 'payto_changed', basis });
  assert.deepEqual(r.basis, basis);
  assert.match(signingMessage(r), /\nbasis: catalog 2026-11-09T21:00:00Z 2026-10-31T08:12:00Z$/);
  const without = refusalReport({ resource, accept: ACCEPT, reason: 'payto_changed', basis: { source: 'catalog', at: '2026-11-09' } });
  assert.match(signingMessage(without), /\nbasis: catalog 2026-11-09$/, 'without it a report signs exactly as before');
  assert.throws(() => refusalReport({ resource, accept: ACCEPT, reason: 'payto_changed', basis: { source: 'live', at: '2026-11-09', listed_updated: '2026-11-01' } }), /only for source "catalog"/);
  assert.throws(() => refusalReport({ resource, accept: ACCEPT, reason: 'payto_changed', basis: { source: 'catalog', at: '2026-11-01', listed_updated: '2026-11-09' } }), /at or before basis.at/);
  assert.throws(() => refusalReport({ resource, accept: ACCEPT, reason: 'price_changed', basis: { source: 'catalog', at: '2026-11-09', listed_updated: 'last week' } }), /UTC date or ISO time/);
  const parsed = parseRefusal({ ...r }, { ownHost: 'x402-doctor.fizzl.eu' });
  assert.deepEqual(parsed.report.basis, basis, 'a receiver keeps it');
});
