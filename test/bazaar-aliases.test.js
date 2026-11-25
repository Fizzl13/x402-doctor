const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bazaarAliases } = require('../lib/bazaar-aliases');

test('an alias path is rewritten to its route, query kept; other paths untouched', () => {
  const mw = bazaarAliases({ '/api/v1/x402-preflight': '/api/v1/preflight' });
  const run = (url) => { const req = { url }; mw(req, {}, () => {}); return req.url; };
  assert.equal(run('/api/v1/x402-preflight?url=https%3A%2F%2Fa.b'), '/api/v1/preflight?url=https%3A%2F%2Fa.b');
  assert.equal(run('/api/v1/x402-preflight/'), '/api/v1/preflight');
  assert.equal(run('/api/v1/preflight'), '/api/v1/preflight');
  assert.equal(run('/api/v1/x402-preflight-other'), '/api/v1/x402-preflight-other');
});
