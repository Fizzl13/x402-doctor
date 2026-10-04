const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutreachHook } = require('../lib/outreach-hook');

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
  const none = hook({ spec: { info: {} } });
  assert.match((await none.h.maybeDraft('https://b.test/x', failing)).skipped, /no contact/);
  const off = createOutreachHook({ url: '', key: '', safeFetch: async () => ({}) });
  assert.equal(off.enabled, false);
  assert.equal((await off.maybeDraft('https://c.test/x', failing)).skipped, 'off_or_not_failing');
  assert.equal(posts.length + none.posts.length, 0);
});
