// POST routes that check their input before the 402: an example body from the caller or the seller's
// /openapi.json reaches the 402, and without one the check says "needs input" instead of "broken".

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { exampleFromOpenApi, normaliseBody, sampleOf, _docs } = require('../lib/request-body');
const { diagnose } = require('../lib/diagnose');
const { preflight } = require('../lib/preflight');
const { buildFixes } = require('../lib/recipes');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createApp } = require('../server');

const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
test.after(() => servers.forEach((s) => s.close()));
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
};
const safeFetch = createSafeFetch({ allowPrivate: true });
const returns402 = (report) => report.checks.find((c) => c.id === 'returns-402');

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'CSV checks' },
  paths: {
    '/v1/csv-preflight': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['csvText'], properties: { csvText: { type: 'string' } } },
              example: { csvText: 'id,amount\nFAKE_ONE,1.25' },
            },
          },
        },
      },
    },
  },
};

// Like the reporter's endpoint: GET 405, POST without csvText 400, POST with csvText 402.
function csvEndpoint({ spec } = {}) {
  return listen(async (req, res) => {
    if (req.url === '/openapi.json') {
      if (!spec) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(spec));
    }
    if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
    let input = {};
    try { input = JSON.parse(await readBody(req) || '{}'); } catch { /* invalid JSON counts as missing input */ }
    if (typeof input.csvText !== 'string') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: false, charged: false, error: 'Provide JSON {csvText:string}' }));
    }
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', b64({ x402Version: 2, error: 'Payment required', resource: { url: `http://${req.headers.host}${req.url}` }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '5000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }] }));
    res.end('{}');
  });
}

test('exampleFromOpenApi: requestBody example, named examples, schema example, or one built from the schema', () => {
  const url = 'https://api.example.com/v1/csv-preflight';
  assert.deepEqual(exampleFromOpenApi(SPEC, url), { body: '{"csvText":"id,amount\\nFAKE_ONE,1.25"}', source: 'requestBody example in /openapi.json' });

  const named = { paths: { '/v1/csv-preflight': { post: { requestBody: { content: { 'application/json': { examples: { small: { value: { csvText: 'a' } } } } } } } } } };
  assert.equal(exampleFromOpenApi(named, url).body, '{"csvText":"a"}');

  const ref = {
    paths: { '/v1/lint': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Lint' } } } } } } },
    components: { schemas: { Lint: { type: 'object', required: ['spec', 'strict'], properties: { spec: { type: 'string', minLength: 10 }, strict: { type: 'boolean' }, extra: { type: 'string' } } } } },
  };
  const built = exampleFromOpenApi(ref, 'https://api.example.com/v1/lint');
  assert.equal(built.source, 'schema in /openapi.json');
  assert.deepEqual(JSON.parse(built.body), { spec: 'examplexxx', strict: true });

  const templated = { servers: [{ url: 'https://api.example.com/api' }], paths: { '/items/{id}/score': { post: { requestBody: { content: { 'application/json': { example: { n: 1 } } } } } } } };
  assert.equal(exampleFromOpenApi(templated, 'https://api.example.com/api/items/42/score').body, '{"n":1}');

  assert.equal(exampleFromOpenApi(SPEC, 'https://api.example.com/v1/other'), null, 'no operation for this path');
  assert.equal(exampleFromOpenApi({ paths: { '/x': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } } } }, 'https://a.example/x'), null, 'nothing required: no example');
});

test('sampleOf: enums, formats, arrays and oneOf', () => {
  assert.deepEqual(sampleOf({}, { type: 'object', required: ['kind', 'email', 'tags', 'pick'], properties: { kind: { enum: ['a', 'b'] }, email: { type: 'string', format: 'email' }, tags: { type: 'array', items: { type: 'string' } }, pick: { oneOf: [{ type: 'integer', minimum: 3 }, { type: 'string' }] } } }),
    { kind: 'a', email: 'agent@example.com', tags: ['example'], pick: 3 });
});

test('normaliseBody: JSON only, at most 16 KB, objects serialised', () => {
  assert.deepEqual(normaliseBody(undefined), { body: undefined });
  assert.deepEqual(normaliseBody({ a: 1 }), { body: '{"a":1}' });
  assert.deepEqual(normaliseBody('{"a":1}'), { body: '{"a":1}' });
  assert.match(normaliseBody('not json').error, /JSON/);
  assert.match(normaliseBody(JSON.stringify({ x: 'y'.repeat(17000) })).error, /too large/);
});

test('diagnose: input checked before the 402 is a warning, not a broken paywall', async () => {
  _docs.clear();
  const url = await csvEndpoint();
  const report = await diagnose(`${url}/v1/csv-preflight`, { safeFetch, method: 'POST' });
  const check = returns402(report);
  assert.equal(check.status, 'warn');
  assert.equal(check.needs_input, true);
  assert.match(check.message, /POST answered 400 without a valid request body/);
  assert.match(check.hint, /example request body/);
  assert.notEqual(report.overall, 'fail');
  const { fixes } = buildFixes(report);
  const fix = fixes.find((f) => f.recipe === 'needs-input');
  assert.ok(fix, 'the fix says how to let agents reach the 402');
  assert.match(fix.code[0].snippet, /"\/v1\/csv-preflight"/);
  assert.ok(!fixes.some((f) => f.recipe === 'no-402'), 'not treated as a missing paywall');
});

test('diagnose: the seller\'s own openapi.json example reaches the 402', async () => {
  _docs.clear();
  const url = await csvEndpoint({ spec: SPEC });
  const report = await diagnose(`${url}/v1/csv-preflight`, { safeFetch });
  const check = returns402(report);
  assert.equal(check.status, 'pass');
  assert.match(check.message, /example body from your requestBody example in \/openapi\.json/);
  assert.match(check.message, /empty body it answered 400/);
  assert.equal(report.method, 'POST');
  assert.equal(report.body_source, 'requestBody example in /openapi.json');
  assert.ok(report.challenge, 'the challenge is read and checked');
  assert.deepEqual(report.probes.map((p) => `${p.method} ${p.status}${p.example ? ' example' : ''}`), ['GET 405', 'POST 400', 'POST 402 example']);
});

test('diagnose: a caller\'s example body reaches the 402; a refused one stays a warning', async () => {
  _docs.clear();
  const url = await csvEndpoint();
  const good = await diagnose(`${url}/v1/csv-preflight`, { safeFetch, method: 'POST', body: '{"csvText":"a,b\\n1,2"}' });
  assert.equal(returns402(good).status, 'pass');
  assert.match(returns402(good).message, /with your example body/);
  assert.equal(good.body, '{"csvText":"a,b\\n1,2"}');

  const bad = await diagnose(`${url}/v1/csv-preflight`, { safeFetch, method: 'POST', body: '{"wrong":1}' });
  assert.equal(returns402(bad).status, 'warn');
  assert.match(returns402(bad).message, /refused this body/);
});

test('diagnose: a POST that answers 404 is still broken', async () => {
  _docs.clear();
  const url = await listen((req, res) => { res.statusCode = 404; res.end(); });
  const report = await diagnose(`${url}/gone`, { safeFetch, method: 'POST' });
  assert.equal(returns402(report).status, 'fail');
});

test('preflight: needs_input is caution, and the openapi example gives a real verdict', async () => {
  _docs.clear();
  const bare = await csvEndpoint();
  const p1 = await preflight(`${bare}/v1/csv-preflight`, { safeFetch, method: 'POST' });
  assert.equal(p1.verdict, 'caution');
  assert.ok(p1.reasons.some((r) => r.code === 'needs_input'));
  assert.ok(!p1.reasons.some((r) => r.code === 'no_402'));

  const listed = await csvEndpoint({ spec: SPEC });
  const p2 = await preflight(`${listed}/v1/csv-preflight`, { safeFetch, method: 'POST' });
  assert.ok(!p2.reasons.some((r) => r.code === 'needs_input' || r.code === 'no_402'));
  assert.ok(p2.options.length > 0, 'the payment options are read');
});

test('POST /api/diagnose: body must be JSON and goes with POST', async () => {
  _docs.clear();
  const app = createApp({ rateLimit: { windowMs: 60_000, max: 20 } });
  const api = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
  const post = (b) => fetch(`${api}/api/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const notJson = await post({ url: 'https://example.com/x', method: 'POST', body: 'not json' });
  assert.equal(notJson.status, 400);
  assert.match((await notJson.json()).error, /JSON/);
  const withGet = await post({ url: 'https://example.com/x', method: 'GET', body: { a: 1 } });
  assert.equal(withGet.status, 400);
  assert.match((await withGet.json()).error, /POST/);
});
