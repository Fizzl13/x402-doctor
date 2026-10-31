// Fizzl Pass phase 2 (lib/fizzl-pass.js): a valid X-Fizzl-Pass proof gets the tier's higher free limit, per pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPassVerifier, limitKeyOf, LIMIT_FACTOR } = require('../lib/fizzl-pass');
const { createApp } = require('../server.js');

// A pass key and proofs as the Agent Wallet makes them (wallet-server src/pass.js).
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const x = publicKey.export({ format: 'jwk' }).x;
const KID = 'testkid';
const jwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: KID, x }] };
function proof(claims, key = privateKey) {
  const body = `fzp1.${Buffer.from(JSON.stringify({ kid: KID, ...claims })).toString('base64url')}`;
  return `${body}.${crypto.sign(null, Buffer.from(body), key).toString('base64url')}`;
}
const good = (over = {}) => proof({ iss: 'wallet.fizzl.eu', tier: 'bronze', until: Date.now() + 86400000, wallets: ['0x1111111111111111111111111111111111111111'], ...over });

test('verify: a valid proof gives its tier and a per-pass key; forged, expired, unknown tier or key are ignored', () => {
  const v = createPassVerifier({ keys: jwks });
  const c = v.verify(good());
  assert.equal(c.tier, 'bronze');
  assert.match(c.ref, /^[0-9a-f]{16}$/);
  assert.equal(v.factor(c), LIMIT_FACTOR.bronze);
  const [h, b, s] = good().split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), tier: 'gold' })).toString('base64url');
  assert.equal(v.verify(`${h}.${changed}.${s}`), null);
  assert.equal(v.verify(good({ until: Date.now() - 1 })), null);
  assert.equal(v.verify(good({ tier: 'platinum' })), null);
  assert.equal(v.verify(proof({ tier: 'bronze', until: Date.now() + 1000 }, crypto.generateKeyPairSync('ed25519').privateKey)), null);
  assert.equal(v.verify('nonsense'), null);
});

test('the public key is fetched once from the wallet, and a failing fetch just means normal limits', async () => {
  let calls = 0;
  const v = createPassVerifier({ jwksUrl: 'https://wallet.test/.well-known/fizzl-pass.json', fetchImpl: async () => { calls++; return Response.json(jwks); } });
  const token = good();
  assert.equal((await v.fromRequest({ headers: { 'x-fizzl-pass': token } })).tier, 'bronze');
  await v.fromRequest({ headers: { 'x-fizzl-pass': token } });
  assert.equal(calls, 1);
  assert.equal(await v.fromRequest({ headers: {} }), null);
  const down = createPassVerifier({ fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await down.fromRequest({ headers: { 'x-fizzl-pass': token } }), null);
  assert.deepEqual(await limitKeyOf(down, { ip: '1.2.3.4', headers: { 'x-fizzl-pass': token } }), { key: '1.2.3.4', factor: 1, claims: null });
});

test('the web limit: a pass holder gets the tier\'s factor, counted per pass, not per IP', async (t) => {
  const app = createApp({ env: {}, rateLimit: { windowMs: 60000, max: 2 }, pass: createPassVerifier({ keys: jwks }), trustIndex: { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const hit = (headers = {}) => fetch(`${base}/api/settlement`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' }).then((r) => r.status);
  assert.notEqual(await hit(), 429);
  assert.notEqual(await hit(), 429);
  assert.equal(await hit(), 429, 'two a minute without a pass');
  const token = good();
  for (let i = 0; i < 2 * LIMIT_FACTOR.bronze; i++) assert.notEqual(await hit({ 'x-fizzl-pass': token }), 429, `pass call ${i + 1}`);
  assert.equal(await hit({ 'x-fizzl-pass': token }), 429, 'the pass has its own, higher limit');
  assert.equal(await hit({ 'x-fizzl-pass': 'fzp1.forged.proof' }), 429, 'a broken proof counts as no pass');
});
