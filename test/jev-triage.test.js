// Jev triage (lib/jev-triage.js) and its use in the outreach hook: no draft for test services or harmless
// findings; off or failing means drafts as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTriage } = require('../lib/jev-triage');
const { createOutreachHook } = require('../lib/outreach-hook');

const quiet = { warn() {}, log() {} };
const jevFetch = (answers, status = 200) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
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
  assert.deepEqual(r, { test: 0.05, real: 0.93, worth: true, why: 'real problem 93%' });
  assert.equal(real.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(real.calls[0].headers.authorization, 'Bearer k');
  assert.equal(real.calls[0].body.state.findings[0].check, 'resource-url');
  const tunnel = await createTriage({ apiKey: 'k', fetch: jevFetch({ test_service: 0.95, real_problem: 0.9 }).fetch, log: quiet }).judge({ url: 'https://x.trycloudflare.com/a', findings });
  assert.equal(tunnel.worth, false);
  assert.match(tunnel.why, /test or preview/);
  const harmless = await createTriage({ apiKey: 'k', fetch: jevFetch({ test_service: 0.1, real_problem: 0.1 }).fetch, log: quiet }).judge({ url: 'https://a.test', findings });
  assert.equal(harmless.worth, false);
  assert.equal((await createTriage({ apiKey: 'k', fetch: jevFetch({ test_service: 0.4, real_problem: 0.4 }).fetch, log: quiet }).judge({ url: 'https://a.test', findings })).worth, true);
  assert.equal(await createTriage({ apiKey: 'k', fetch: jevFetch({}, 529).fetch, log: quiet }).judge({ url: 'https://a.test', findings }), null);
});

test('outreach hook: Jev holds back a draft for a test service, and drafts as before when Jev fails', async () => {
  const failing = { overall: 'fail', checks: [{ id: 'resource-url', status: 'fail', message: 'resource.url is http on an https endpoint.' }] };
  const posts = [];
  const safeFetch = async () => ({ status: 200, text: JSON.stringify({ info: { contact: { email: 'ops@seller.test' } } }), truncated: false });
  const walletFetch = async (u, init) => { posts.push(u); return new Response(JSON.stringify({ draft: { id: 'ow_1' } }), { status: 200 }); };
  const held = createOutreachHook({ url: 'https://wallet.test', key: 'k', safeFetch, fetch: walletFetch, log: quiet, triage: createTriage({ apiKey: 'k', fetch: jevFetch({ test_service: 0.97, real_problem: 0.8 }).fetch, log: quiet }) });
  assert.match((await held.maybeDraft('https://demo.ngrok-free.dev/x', failing)).skipped, /^Jev: looks like a test/);
  assert.equal(posts.length, 0);
  const down = createOutreachHook({ url: 'https://wallet.test', key: 'k', safeFetch, fetch: walletFetch, log: quiet, triage: createTriage({ apiKey: 'k', fetch: jevFetch({}, 500).fetch, log: quiet }) });
  assert.deepEqual(await down.maybeDraft('https://api.seller.test/x', failing), { drafted: 'api.seller.test' });
});
