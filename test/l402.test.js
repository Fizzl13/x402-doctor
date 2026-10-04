const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { checkL402, parseL402, decodeBolt11 } = require('../lib/l402');
const { diagnose } = require('../lib/diagnose');
const { preflight } = require('../lib/preflight');

// A BOLT 11 invoice that decodes (right checksum; the signature is filler, Doctor doesn't verify it).
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]; }
  return chk >>> 0;
}
const toWords = (n, len) => Array.from({ length: len }, (_, i) => Math.floor(n / 32 ** (len - 1 - i)) % 32);
function invoice({ hrp = 'lnbc100n', timestamp = Math.floor(Date.now() / 1000), expiry = 600 } = {}) {
  const words = [...toWords(timestamp, 7), 1, 1, 20, ...new Array(52).fill(0), 6, 0, 2, ...toWords(expiry, 2), ...new Array(104).fill(3)];
  const exp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...exp, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}
const MAC = Buffer.concat([Buffer.from([2]), Buffer.alloc(40, 7)]).toString('base64');

function serve({ challenge, badCredential = 401 } = {}) {
  const app = express();
  app.get('/paid', (req, res) => {
    if (req.headers.authorization) return res.status(badCredential).json({ error: 'bad credential' });
    res.status(402).set('WWW-Authenticate', challenge).json({ error: 'payment required' });
  });
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => resolve({ url: `http://127.0.0.1:${server.address().port}/paid`, close: () => server.close() }));
  });
}
const safeFetch = (u, o) => fetch(u, o);

test('decodeBolt11 reads the BOLT 11 spec example (2500u = 250,000 sats, 60 s expiry)', () => {
  const inv = 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh';
  const d = decodeBolt11(inv);
  assert.deepEqual([d.network, d.msat, d.timestamp, d.expiry], ['bitcoin', 250_000_000n, 1496314658, 60]);
  assert.throws(() => decodeBolt11(inv.slice(0, -1) + 'q'), /checksum/);
  assert.equal(decodeBolt11(invoice({ hrp: 'lntb1u' })).network, 'testnet');
  assert.equal(decodeBolt11(invoice({ hrp: 'lnbc' })).msat, null);
});

test('parseL402 reads L402 and LSAT challenges, and "token" for the macaroon', () => {
  const inv = invoice();
  const list = parseL402(`LSAT macaroon="${MAC}", invoice="${inv}", L402 token="${MAC}", invoice="${inv}"`);
  assert.deepEqual(list.map((c) => c.scheme), ['LSAT', 'L402']);
  assert.equal(list[1].params.macaroon, MAC);
});

test('a good L402 endpoint passes: macaroon, mainnet invoice with a price, not expired, 401 for a wrong preimage', async (t) => {
  const inv = invoice();
  const s = await serve({ challenge: `LSAT macaroon="${MAC}", invoice="${inv}", L402 macaroon="${MAC}", invoice="${inv}"` });
  t.after(s.close);
  const res = await fetch(s.url);
  const checks = [];
  const out = await checkL402({ res, url: s.url, method: 'GET', safeFetch }, checks);
  assert.deepEqual(checks.filter((c) => c.status !== 'pass').map((c) => c.id), []);
  assert.equal(checks.find((c) => c.id === 'l402-amount').message, 'Price: 10 sats.');
  assert.equal(out.challenges[0].sats, 10);
});

test('broken L402: expired or testnet invoice, no amount, bad macaroon, served without payment', async (t) => {
  const old = invoice({ timestamp: Math.floor(Date.now() / 1000) - 7200, expiry: 600 });
  let s = await serve({ challenge: `L402 macaroon="%%%", invoice="${old}"`, badCredential: 200 });
  t.after(s.close);
  let checks = [];
  await checkL402({ res: await fetch(s.url), url: s.url, method: 'GET', safeFetch }, checks);
  const status = (id) => checks.find((c) => c.id === id)?.status;
  assert.equal(status('l402-macaroon'), 'fail');
  assert.equal(status('l402-expiry'), 'fail');
  assert.equal(status('l402-bad-credential'), 'fail');
  assert.equal(status('l402-lsat'), 'info');
  s = await serve({ challenge: `L402 macaroon="${MAC}", invoice="${invoice({ hrp: 'lntb' })}"`, badCredential: 402 });
  t.after(s.close);
  checks = [];
  await checkL402({ res: await fetch(s.url), url: s.url, method: 'GET', safeFetch }, checks);
  assert.equal(status('l402-network'), 'warn');
  assert.equal(status('l402-amount'), 'warn');
  assert.equal(status('l402-bad-credential'), 'warn');
});

test('diagnose: an L402-only endpoint is an L402 endpoint, not a broken x402 one', async (t) => {
  const inv = invoice();
  const s = await serve({ challenge: `L402 macaroon="${MAC}", invoice="${inv}"` });
  t.after(s.close);
  const r = await diagnose(s.url, { safeFetch });
  const pv = r.checks.find((c) => c.id === 'protocol-version');
  assert.equal(pv.status, 'info');
  assert.match(pv.message, /L402 \(Lightning\) endpoint/);
  assert.equal(r.l402[0].sats, 10);
  assert.ok(r.checks.some((c) => c.group === 'l402' && c.id === 'l402-challenge' && c.status === 'pass'));
});

test('preflight: L402-only is payable in sats, with l402_only and priced_in_sats', async (t) => {
  const s = await serve({ challenge: `L402 macaroon="${MAC}", invoice="${invoice()}"` });
  t.after(s.close);
  const r = await preflight(s.url, { safeFetch });
  assert.equal(r.verdict, 'caution');
  assert.deepEqual(r.reasons.map((x) => x.code).filter((c) => c !== 'not_https'), ['l402_only', 'priced_in_sats']);
  assert.deepEqual(r.signals.protocols, ['l402']);
  const o = r.options[r.recommended_option];
  assert.deepEqual([o.protocol, o.amount, o.network, o.payable], ['l402', '10', 'lightning:bitcoin', true]);
  assert.match(r.summary, /10 sats on Lightning \(bitcoin\)/);
});
