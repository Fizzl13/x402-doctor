// The get-probe check (lib/diagnose.js): a POST route whose unpaid GET answers 404 is listed as gone by directories
// that probe with GET; a GET that gets the 402 too is fine.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { diagnose } = require('../lib/diagnose');
const { buildFixes } = require('../lib/recipes');
const { createSafeFetch } = require('../lib/safe-fetch');

const servers = [];
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
test.after(() => servers.forEach((s) => s.close()));
const safeFetch = createSafeFetch({ allowPrivate: true });
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

// A POST route with a 402; GET answers getStatus (402 means the same 402 as POST).
function postRoute(getStatus) {
  return listen((req, res) => {
    if (req.url !== '/v1/check') { res.statusCode = 404; return res.end(); }
    const status = req.method === 'POST' || getStatus === 402 ? 402 : getStatus;
    res.statusCode = status;
    if (status === 402) {
      const challenge = { x402Version: 2, resource: { url: `http://${req.headers.host}/v1/check` }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }] };
      res.setHeader('PAYMENT-REQUIRED', b64(challenge));
      res.setHeader('content-type', 'application/json');
      return res.end('{}');
    }
    res.setHeader('content-type', 'text/html');
    res.end('<h1>Not found</h1>');
  });
}
const getProbe = (report) => report.checks.find((c) => c.id === 'get-probe');

test('a POST route whose GET answers 404 gets a warning; with the method given, Doctor asks GET once more', async () => {
  const base = await postRoute(404);
  const found = await diagnose(`${base}/v1/check`, { safeFetch });
  assert.equal(found.checks.find((c) => c.id === 'returns-402').status, 'pass');
  assert.equal(getProbe(found).status, 'warn');
  assert.match(getProbe(found).message, /answers 404.*list this route as gone/);
  const declared = await diagnose(`${base}/v1/check`, { safeFetch, method: 'POST' });
  assert.equal(getProbe(declared).status, 'warn');
});

test('GET with the 402 passes, 405 is a note, and a GET route is not asked about', async () => {
  assert.equal(getProbe(await diagnose(`${await postRoute(402)}/v1/check`, { safeFetch, method: 'POST' })).status, 'pass');
  assert.equal(getProbe(await diagnose(`${await postRoute(405)}/v1/check`, { safeFetch })).status, 'info');
  assert.equal(getProbe(await diagnose(`${await postRoute(402)}/v1/check`, { safeFetch })), undefined, 'GET got the 402 first: a GET route');
});

test('the paid fix turns the warning into the GET/HEAD middleware for this path', async () => {
  const report = await diagnose(`${await postRoute(404)}/v1/check`, { safeFetch, method: 'POST' });
  const f = buildFixes(report, { stack: 'express' }).fixes.find((x) => x.recipe === 'get-probe');
  assert.ok(f, 'a get-probe fix');
  assert.match(f.code.map((c) => c.snippet).join('\n'), /new Set\(\["\/v1\/check"\]\)/);
});
