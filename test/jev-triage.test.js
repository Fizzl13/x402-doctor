// Jev triage (lib/jev-triage.js) and its use in the outreach hook: no draft for test services or harmless
// findings; off or failing means drafts as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTriage, testByAddress } = require('../lib/jev-triage');
const { createOutreachHook } = require('../lib/outreach-hook');

const quiet = { warn() {}, log() {} };
const jevFetch = (answers, status = 200, claude = null) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (url.startsWith('https://api.anthropic.com/')) return Response.json({ content: [{ type: 'text', text: JSON.stringify(claude) }] });
    if (status !== 200) return new Response('{}', { status });
    return Response.json({ model: 'jev-test', answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { type: 'noul', noul: v }])), usage: {} });
  };
  return { fetch, calls };
};
const findings = [{ id: 'resource-url', message: 'resource.url https://127.0.0.1:9078/v1/embed differs from the requested URL.' }];

test('triage: off without a key; sure answers decide; in between is worth a mail', async () => {
  assert.equal(await createTriage({ apiKey: '' }).judge({ url: 'https://a.test', findings }), null);
  const real = jevFetch({ test_service: 0.05, real_problem: 0.93 });
  const r = await createTriage({ apiKey: 'k', fetch: real.fetch, log: quiet }).judge({ url: 'https://api.grip.test/v1/embed', findings });
  assert.deepEqual(r, { test: 0.05, real: 0.93, worth: true, why: 'real problem (93%)', decidedBy: 'jev' });
  assert.equal(real.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(real.calls[0].headers.authorization, 'Bearer k');
  assert.equal(real.calls[0].body.state.findings[0].check, 'resource-url');
  const tunnel = await createTriage({ apiKey: 'k', fetch: jevFetch({ test_service: 0.95, real_problem: 0.9 }).fetch, log: quiet }).judge({ url: 'https://api.seller-preview-like.test/a', findings });
  assert.equal(tunnel.worth, false);
  assert.match(tunnel.why, /test or preview/);
  const harmless = await createTriage({ apiKey: 'k', fetch: jevFetch({ test_service: 0.1, real_problem: 0.1 }).fetch, log: quiet }).judge({ url: 'https://a.test', findings });
  assert.equal(harmless.worth, false);
  // In between: unsure without Claude; Claude decides when there is a key.
  const unsure = await createTriage({ apiKey: 'k', anthropicKey: '', fetch: jevFetch({ test_service: 0.4, real_problem: 0.4 }).fetch, log: quiet }).judge({ url: 'https://a.test', findings });
  assert.equal(unsure.worth, null);
  assert.equal(unsure.decidedBy, 'none');
  const claudeYes = await createTriage({ apiKey: 'k', anthropicKey: 'an', fetch: jevFetch({ test_service: 0.4, real_problem: 0.4 }, 200, { test: false, real: true }).fetch, log: quiet }).judge({ url: 'https://a.test', findings });
  assert.deepEqual([claudeYes.worth, claudeYes.decidedBy], [true, 'jev+claude']);
  const claudeNo = await createTriage({ apiKey: 'k', anthropicKey: 'an', fetch: jevFetch({ test_service: 0.4, real_problem: 0.4 }, 200, { test: false, real: false }).fetch, log: quiet }).judge({ url: 'https://a.test', findings });
  assert.deepEqual([claudeNo.worth, claudeNo.why], [false, 'harmless or deliberate (Claude)']);
  assert.equal(await createTriage({ apiKey: 'k', fetch: jevFetch({}, 529).fetch, log: quiet }).judge({ url: 'https://a.test', findings }), null);
});

test('outreach hook: Jev holds back a draft for a test service, and drafts as before when Jev fails', async () => {
  const failing = { overall: 'fail', checks: [{ id: 'resource-url', status: 'fail', message: 'resource.url is http on an https endpoint.' }] };
  const posts = [];
  const safeFetch = async () => ({ status: 200, text: JSON.stringify({ info: { contact: { email: 'ops@seller.test' } } }), truncated: false });
  const walletFetch = async (u, init) => { posts.push(u); return new Response(JSON.stringify({ draft: { id: 'ow_1' } }), { status: 200 }); };
  const held = createOutreachHook({ url: 'https://wallet.test', key: 'k', safeFetch, fetch: walletFetch, log: quiet, triage: createTriage({ apiKey: 'k', fetch: jevFetch({ test_service: 0.97, real_problem: 0.8 }).fetch, log: quiet }) });
  assert.match((await held.maybeDraft('https://api.quiet-seller.test/x', failing)).skipped, /^Jev: looks like a test/);
  assert.equal(posts.length, 0);
  const down = createOutreachHook({ url: 'https://wallet.test', key: 'k', safeFetch, fetch: walletFetch, log: quiet, triage: createTriage({ apiKey: 'k', fetch: jevFetch({}, 500).fetch, log: quiet }) });
  assert.deepEqual(await down.maybeDraft('https://api.seller.test/x', failing), { drafted: 'api.seller.test' });
});

test('test addresses are decided by code without asking Jev; *.dev hosting is not a test', async () => {
  for (const u of ['https://staging.flint.network/a', 'https://flint-18glyl6bv-jt-taylors-projects.vercel.app/x', 'https://agent-api-testnet.tim1712.workers.dev/x', 'https://x.trycloudflare.com/a', 'https://demo.ngrok-free.dev/x', 'https://test.x402labs.sh/a']) assert.ok(testByAddress(u), u);
  for (const u of ['https://crawler-toll-gateway.danightshift.workers.dev/x', 'https://mytest.io/a', 'https://api.grip.fyi/x', 'https://my-app.vercel.app/x']) assert.equal(testByAddress(u), null, u);
  const j = jevFetch({});
  const r = await createTriage({ apiKey: 'k', fetch: j.fetch, log: quiet }).judge({ url: 'https://staging.flint.network/a', findings });
  assert.deepEqual([r.worth, r.decidedBy], [false, 'address']);
  assert.equal(j.calls.length, 0);
});

test('outreach hook: an unsure case still becomes a draft (the owner decides)', async () => {
  const failing = { overall: 'fail', checks: [{ id: 'resource-url', status: 'fail', message: 'resource.url differs.' }] };
  const safeFetch = async () => ({ status: 200, text: JSON.stringify({ info: { contact: { email: 'ops@seller.test' } } }), truncated: false });
  const walletFetch = async () => new Response(JSON.stringify({ draft: { id: 'ow_1' } }), { status: 200 });
  const h = createOutreachHook({ url: 'https://wallet.test', key: 'k', safeFetch, fetch: walletFetch, log: quiet, triage: createTriage({ apiKey: 'k', anthropicKey: '', fetch: jevFetch({ test_service: 0.3, real_problem: 0.5 }).fetch, log: quiet }) });
  assert.deepEqual(await h.maybeDraft('https://api.seller.test/x', failing), { drafted: 'api.seller.test' });
});
