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

const { paymentOf, paymentFromHeaders, svmPayer, base58 } = require('../lib/receipt');

test('payment: EVM EIP-3009 payer + nonce from either header name; inside the signed bytes', async () => {
  const payload = {
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25' },
    payload: { signature: '0x11', authorization: { from: '0x0fD3D46E688855B24536df33BBa3dFa35b67445C', value: '1000', nonce: '0xabc' } },
  };
  const header = Buffer.from(JSON.stringify(payload)).toString('base64');
  assert.equal(paymentFromHeaders({ 'payment-signature': header }).nonce, '0xabc');
  assert.equal(paymentFromHeaders({ 'x-payment': header }).payer, '0x0fD3D46E688855B24536df33BBa3dFa35b67445C');
  assert.equal(paymentFromHeaders({ 'payment-signature': 'x' }), null);
  const signer = createSigner({ RECEIPT_SIGNER_SECRET: SECRET });
  const signed = await signer.sign({ verdict: 'go' }, { route: 'GET /api/v1/preflight', input: {}, payment: paymentOf(payload) });
  assert.equal(signed.receipt.payment.proof, 'eip3009');
  const swapped = { ...signed, receipt: { ...signed.receipt, payment: { ...signed.receipt.payment, nonce: '0xdef' } } };
  assert.equal((await verifyReceipt(swapped, { signers: signer.signers })).valid, false);
});

test('payment: Solana transfer authority is signer #2 after the fee payer', () => {
  const authority = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  const tx = Buffer.concat([Buffer.from([2]), Buffer.alloc(128), Buffer.from([0x80, 2, 0, 1, 3]), Buffer.alloc(32, 7), authority, Buffer.alloc(32, 9), Buffer.alloc(40)]);
  assert.equal(base58(authority), '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw', 'same as @solana/kit (checked in presign-guard)');
  assert.equal(svmPayer(tx.toString('base64')), '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw');
  assert.equal(svmPayer('!!'), null);
});
