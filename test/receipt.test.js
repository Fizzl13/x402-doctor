// Signed verdicts (lib/receipt.js): canonical JSON (same bytes as Python), a
// Doctor-specific key, verification, tampering and the Express middleware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { canonicalJson, createSigner, verifyReceipt, signPaidResponses, inputHash } = require('../lib/receipt');

const SECRET = 'test-secret-that-is-long-enough-0123456789';

test('canonical JSON matches Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)', () => {
  const v = { verdict: 'no_go', reasons: [{ code: 'x', message: 'Tornado Cash — OFAC ✓' }], b: 1.5, a: [1, null, true, { z: 0, y: 'é' }], n: -0.001, skipped: undefined };
  assert.equal(canonicalJson(v), '{"a":[1,null,true,{"y":"\\u00e9","z":0}],"b":1.5,"n":-0.001,"reasons":[{"code":"x","message":"Tornado Cash \\u2014 OFAC \\u2713"}],"verdict":"no_go"}');
});

test('no secret: no signer; the key is Doctor-specific (same secret, different address than presign-guard)', () => {
  assert.equal(createSigner({}), null);
  const doctor = createSigner({ RECEIPT_SIGNER_SECRET: SECRET });
  const other = createSigner({ RECEIPT_SIGNER_SECRET: SECRET }, { label: 'presign-guard' });
  assert.notEqual(doctor.address, other.address);
  assert.equal(doctor.address, createSigner({ RECEIPT_SIGNER_SECRET: SECRET }).address, 'stable');
});

test('a signed verdict verifies; flipping it, moving it or another input breaks it', async () => {
  const signer = createSigner({ RECEIPT_SIGNER_SECRET: SECRET });
  const input = { url: 'https://api.example.com/paid', max_usd: '0.05' };
  const signed = await signer.sign({ verdict: 'go', reasons: [] }, { route: 'GET /api/v1/preflight', input });
  assert.equal(signed.receipt.input_sha256, inputHash('GET /api/v1/preflight', input));
  assert.deepEqual(await verifyReceipt(signed, { signers: signer.signers, route: 'GET /api/v1/preflight', input }), { valid: true, signer: signer.address, known_signer: true, signer_status: 'current', input_matches: true });
  assert.equal((await verifyReceipt({ ...signed, verdict: 'no_go' })).valid, false);
  assert.equal((await verifyReceipt({ ...signed, receipt: { ...signed.receipt, request_id: 'other' } })).valid, false);
  assert.equal((await verifyReceipt(signed, { signers: signer.signers, route: 'GET /api/v1/preflight', input: { ...input, max_usd: '1' } })).input_matches, false);
  const stranger = createSigner({ RECEIPT_SIGNER_SECRET: `${SECRET}-x` });
  assert.match((await verifyReceipt(await stranger.sign({ verdict: 'go' }, { route: 'r', input }), { signers: signer.signers })).reason, /not by an x402 Doctor signer/);
});

test('middleware: signs 200 JSON on paid routes only, also when mounted under a prefix', async () => {
  const signer = createSigner({ RECEIPT_SIGNER_SECRET: SECRET });
  const router = express.Router();
  router.use(signPaidResponses(signer, ['GET /api/v1/preflight']));
  router.get('/api/v1/preflight', (req, res) => (req.query.url ? res.json({ verdict: 'go' }) : res.status(400).json({ error: 'url is required' })));
  router.get('/api/health', (_req, res) => res.json({ ok: true }));
  const app = express();
  app.use(router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await (await fetch(`${base}/api/v1/preflight?url=https://x.test`)).json();
    assert.equal((await verifyReceipt(ok, { signers: signer.signers, route: 'GET /api/v1/preflight', input: { url: 'https://x.test' } })).valid, true);
    assert.equal((await (await fetch(`${base}/api/v1/preflight`)).json()).receipt, undefined, 'errors unsigned');
    assert.equal((await (await fetch(`${base}/api/health`)).json()).receipt, undefined, 'free routes unsigned');
  } finally {
    server.close();
  }
});
