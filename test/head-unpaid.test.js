// HEAD on a paid GET route: up to @x402/core 2.28.0 the middleware let it through unpaid and the framework ran the
// GET handler (x402-foundation/x402#3796). The web check sends one HEAD request.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSafeFetch } = require('../lib/safe-fetch');
const { checkHeadUnpaid } = require('../lib/diagnose');
const { buildFixes } = require('../lib/recipes');

const servers = [];
test.after(() => servers.forEach((s) => s.close()));
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/paid`));
  servers.push(server);
});
const safeFetch = createSafeFetch({ allowPrivate: true, timeoutMs: 2000 });

test('a 2xx to HEAD where GET asks for 402 is a warning, with a fix; 402 or 405 to HEAD passes', async () => {
  const handlerRuns = [];
  const leaky = await listen((req, res) => {
    if (req.method === 'GET') { res.statusCode = 402; return res.end('{}'); }
    handlerRuns.push(req.method); // what an unpatched middleware does: the handler runs for HEAD
    res.statusCode = 200;
    res.end();
  });
  const checks = [];
  await checkHeadUnpaid(leaky, { method: 'GET' }, safeFetch, checks);
  assert.deepEqual(handlerRuns, ['HEAD']);
  const c = checks.find((x) => x.id === 'head-unpaid');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /^HEAD answers 200 without payment, while GET asks for 402/);
  assert.match(c.hint, /x402-foundation\/x402#3796/);
  const fixes = buildFixes({ url: leaky, checks, stack: 'express' }, { stack: 'express' });
  assert.ok((fixes.fixes || fixes).some((f) => /Make HEAD pay too/.test(f.title)), 'a fix recipe comes with it');

  for (const status of [402, 405]) {
    const ok = await listen((req, res) => { res.statusCode = req.method === 'HEAD' ? status : 402; res.end(); });
    const passing = [];
    await checkHeadUnpaid(ok, { method: 'GET' }, safeFetch, passing);
    assert.equal(passing.find((x) => x.id === 'head-unpaid').status, 'pass');
  }
});

test('nothing for a POST route or a host that does not answer HEAD', async () => {
  const checks = [];
  await checkHeadUnpaid('http://127.0.0.1:9/paid', { method: 'POST' }, safeFetch, checks);
  await checkHeadUnpaid('http://127.0.0.1:1/paid', { method: 'GET' }, safeFetch, checks);
  assert.deepEqual(checks, []);
});
