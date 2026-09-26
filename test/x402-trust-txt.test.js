const test = require('node:test');
const assert = require('node:assert/strict');
const { x402TrustTxt } = require('../lib/x402-trust-txt');
const { createApp } = require('../server.js');

const KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'a'.repeat(86);
const LINE = `x402-trust-verification=v1:${KEY}`;

test('only a well-formed verification line is served', () => {
  assert.equal(x402TrustTxt(` ${LINE}\n`), `${LINE}\n`);
  assert.equal(x402TrustTxt(undefined), null);
  assert.equal(x402TrustTxt('x402-trust-remove'), null, 'never a removal line from a setting');
  assert.equal(x402TrustTxt(`${LINE}\nx402-trust-remove`), null);
  assert.equal(x402TrustTxt('x402-trust-verification=v1:<script>'), null);
});

test('GET /.well-known/x402-trust.txt: the line when set, 404 otherwise', async (t) => {
  const listen = (app) => new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const set = await listen(createApp({ env: { X402_TRUST_TXT: LINE } }));
  const unset = await listen(createApp({ env: {} }));
  t.after(() => { set.close(); unset.close(); });
  const a = await fetch(`http://127.0.0.1:${set.address().port}/.well-known/x402-trust.txt`);
  assert.equal(a.status, 200);
  assert.match(a.headers.get('content-type'), /text\/plain/);
  assert.equal(await a.text(), `${LINE}\n`);
  const b = await fetch(`http://127.0.0.1:${unset.address().port}/.well-known/x402-trust.txt`);
  assert.equal(b.status, 404);
});
