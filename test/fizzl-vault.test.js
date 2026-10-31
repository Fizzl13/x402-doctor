// Fizzl Pass phase 3 (lib/fizzl-vault.js): part of a paid call comes back as credit in the pass's vault, and a call
// with the pass proof and no payment is paid from the vault.
process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { createApp } = require('../server');
const { createPassVerifier } = require('../lib/fizzl-pass');
const { createVault, memoryVault, paidOf, usdOf, VAULT_SHARE } = require('../lib/fizzl-vault');

const BASE = 'eip155:8453';
const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const OWNER = '0x1111111111111111111111111111111111111111';

// Pass proofs as the Agent Wallet makes them (wallet-server src/pass.js).
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const jwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'testkid', x: publicKey.export({ format: 'jwk' }).x }] };
function proof(claims) {
  const body = `fzp1.${Buffer.from(JSON.stringify({ kid: 'testkid', iss: 'wallet.fizzl.eu', tier: 'bronze', until: Date.now() + 86400000, ...claims })).toString('base64url')}`;
  return `${body}.${crypto.sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');

test('the store takes from all the pass wallets together, only when they hold enough', async () => {
  const v = memoryVault();
  await v.credit('a', 300, 100);
  await v.credit('b', 500, 0);
  assert.equal(await v.balance(['a', 'b', 'c']), 800);
  assert.deepEqual(await v.take(['a', 'b'], 900), { ok: false, balance: 800 });
  assert.deepEqual(await v.take(['a', 'b'], 600), { ok: true, balance: 200 });
  assert.equal(await v.balance(['a']), 0);
  await v.refund('a', 600, 100);
  assert.equal(await v.balance(['a', 'b']), 800);
});

test('the store ends Bronze credit after its time; Gold credit stays', async () => {
  let t = 0;
  const v = memoryVault({ now: () => t });
  await v.credit('bronze', 100, 10);
  await v.credit('gold', 100, 0);
  t = 11_000;
  assert.equal(await v.balance(['bronze']), 0);
  assert.equal(await v.balance(['gold']), 100);
});

test('paidOf reads payer and dollars from the settlement and payment headers; usdOf per network', () => {
  const req = { headers: { 'payment-signature': b64({ accepted: { network: BASE, amount: '10000' } }) } };
  const res = { statusCode: 200, locals: {}, getHeader: (h) => (h === 'PAYMENT-RESPONSE' ? b64({ success: true, payer: OWNER, transaction: '0x1' }) : undefined) };
  assert.deepEqual(paidOf(req, res), { payer: OWNER, usd: 0.01 });
  assert.equal(paidOf(req, { ...res, statusCode: 500 }), null);
  assert.equal(paidOf({ headers: {} }, { ...res, getHeader: () => undefined }), null);
  assert.deepEqual(paidOf({ headers: {} }, { statusCode: 200, locals: { mppPayment: { payer: OWNER, usd: 0.005 } }, getHeader: () => undefined }), { payer: OWNER, usd: 0.005 });
  assert.equal(usdOf({ network: 'stellar:pubnet', amount: '100000' }), 0.01);
  assert.equal(usdOf({ network: 'xrpl:0', amount: '0.01', asset: '524C555344000000000000000000000000000000' }), 0.01);
  assert.equal(usdOf({ network: 'xrpl:0', amount: '10000', asset: 'XRP' }), null);
});

test('credit back: the share of the pass tier, from the proof or the wallet check; nothing without a pass', async () => {
  const store = memoryVault();
  const looked = [];
  const status = { [OWNER]: null, '0x2222222222222222222222222222222222222222': { tier: 'gold', until: Date.now() + 86400000 } };
  const fetchImpl = async (url) => { const w = new URL(url).searchParams.get('wallet'); looked.push(w); return { ok: true, json: async () => ({ wallet: w, pass: status[w] ?? null }) }; };
  const vault = createVault({ store, pass: createPassVerifier({ keys: jwks }), fetchImpl });
  const paid = (payer, headers = {}) => [
    { headers: { 'payment-signature': b64({ accepted: { network: BASE, amount: '50000' } }), ...headers } },
    { statusCode: 200, locals: {}, getHeader: (h) => (h === 'PAYMENT-RESPONSE' ? b64({ success: true, payer }) : undefined) },
  ];
  // The call's own proof lists the paying wallet: Bronze, 10% of $0.05.
  assert.equal(await vault.creditPaid(...paid(OWNER, { 'x-fizzl-pass': proof({ wallets: [OWNER] }) })), 5000);
  assert.equal(looked.length, 0, 'no wallet check needed');
  // A proof that doesn't list the payer counts for nothing; the wallet check says no pass.
  assert.equal(await vault.creditPaid(...paid(OWNER, { 'x-fizzl-pass': proof({ wallets: ['0x3333333333333333333333333333333333333333'] }) })), 0);
  // No proof: the wallet check finds a Gold pass, 30%. Checked once per 10 minutes.
  const gold = '0x2222222222222222222222222222222222222222';
  assert.equal(await vault.creditPaid(...paid(gold.toUpperCase().replace('0X', '0x'))), 15000);
  assert.equal(await vault.creditPaid(...paid(gold)), 15000);
  assert.equal(looked.filter((w) => w === gold).length, 1);
  assert.equal(await store.balance([OWNER]), 5000);
  assert.equal(await store.balance([gold]), 30000);
  assert.equal(VAULT_SHARE.silver, 0.2);
});

test('credit back: a failed wallet check is not kept, and credits or vault calls get nothing back', async () => {
  const store = memoryVault();
  let up = false;
  const fetchImpl = async () => (up ? { ok: true, json: async () => ({ pass: { tier: 'bronze', until: Date.now() + 1e6 } }) } : { ok: false });
  const vault = createVault({ store, fetchImpl });
  const req = { headers: { 'payment-signature': b64({ accepted: { network: BASE, amount: '10000' } }) } };
  const res = { statusCode: 200, locals: {}, getHeader: (h) => (h === 'PAYMENT-RESPONSE' ? b64({ success: true, payer: OWNER }) : undefined) };
  assert.equal(await vault.creditPaid(req, res), 0);
  up = true;
  assert.equal(await vault.creditPaid(req, res), 1000);
  assert.equal(await vault.creditPaid({ ...req, fizzlCredits: { vault: 1000 } }, res), 0);
});

// The whole flow on x402 Doctor: a real x402 payment (mock facilitator), credit back, then a call paid from the vault.
const servers = [];
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  servers.push(server);
});
const json = (res, value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
async function body(req) { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }
test.after(() => servers.forEach((s) => s.close()));

test('Doctor: a pass wallet pays a diagnosis, gets 10% back, and the vault then pays a preflight', async () => {
  const facilitatorUrl = await listen(async (req, res) => {
    if (req.url.endsWith('/supported')) return json(res, { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }], extensions: [], signers: {} });
    const { paymentPayload } = await body(req);
    const from = paymentPayload.payload.authorization.from;
    if (req.url.endsWith('/verify')) return json(res, { isValid: true, payer: from });
    return json(res, { success: true, transaction: '0xsettled', network: BASE, payer: from });
  });
  const targetUrl = await listen((_req, res) => {
    const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', network: BASE, amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO_BASE, maxTimeoutSeconds: 60 }] };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    json(res, challenge);
  });
  const store = memoryVault();
  const app = createApp({ allowPrivate: true, env: { AGENT_PAYOUT_WALLET: PAY_TO_BASE, FACILITATOR_URL: facilitatorUrl, PASS_STATUS_URL: 'http://127.0.0.1:1/v1/pass/status' }, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, pass: createPassVerifier({ keys: jwks }), vaultStore: store, creditStore: null });
  const api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });

  const account = privateKeyToAccount(generatePrivateKey());
  const pass = proof({ wallets: [OWNER, account.address] });
  const preflight = `${api}/api/v1/preflight?url=${encodeURIComponent(targetUrl)}`;

  // Empty vault: the normal 402.
  const before = await fetch(preflight, { headers: { 'x-fizzl-pass': pass } });
  assert.equal(before.status, 402);
  assert.equal(before.headers.get('x-fizzl-vault'), 'insufficient');

  // The agent pays a diagnosis ($0.01) with its own x402 client and the pass proof: $0.001 comes back.
  const client = new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  const paid = await wrapFetchWithPayment(fetch, client)(`${api}/api/v1/diagnose?url=${encodeURIComponent(targetUrl)}`, { headers: { 'x-fizzl-pass': pass } });
  assert.equal(paid.status, 200);
  await new Promise((r) => setTimeout(r, 50)); // credited after the answer is sent
  assert.equal(await store.balance([account.address.toLowerCase()]), 1000);

  const bal = await (await fetch(`${api}/api/v1/vault`, { headers: { 'x-fizzl-pass': pass } })).json();
  assert.equal(bal.balance_usd, 0.001);
  assert.equal(bal.tier, 'bronze');

  // That pays a preflight ($0.001) without a payment.
  const fromVault = await fetch(preflight, { headers: { 'x-fizzl-pass': pass } });
  assert.equal(fromVault.status, 200);
  assert.equal(fromVault.headers.get('x-fizzl-vault'), 'paid');
  assert.equal(fromVault.headers.get('x-fizzl-vault-balance'), '0');
  assert.equal(fromVault.headers.get('cache-control'), 'private, no-store');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await store.balance([OWNER, account.address.toLowerCase()]), 0, 'a call paid from the vault earns nothing back');

  // A failed call gives it back; a forged proof is ignored.
  await store.credit(OWNER, 1000, 100);
  const bad = await fetch(`${api}/api/v1/preflight?url=not-a-url`, { headers: { 'x-fizzl-pass': pass } });
  assert.equal(bad.status, 400);
  assert.equal(await store.balance([OWNER]), 1000);
  const forged = await fetch(preflight, { headers: { 'x-fizzl-pass': `${pass.slice(0, -4)}AAAA` } });
  assert.equal(forged.status, 402);
  assert.equal((await fetch(`${api}/api/v1/vault`, { headers: { 'x-fizzl-pass': 'fzp1.x.y' } })).status, 401);
  const info = await (await fetch(`${api}/api/v1/vault`)).json();
  assert.equal(info.balance_usd, null);
  assert.equal(info.share.gold, 0.3);
});

test('Fizzl Buy: a purchase is paid from the vault (skipping the paywall) and given back when it fails', async () => {
  const { createBuyApp } = require('../buy-server');
  const store = memoryVault();
  let walled = 0;
  const paywall = (_req, res) => { walled++; res.status(402).json({ error: 'pay' }); };
  const noLog = { middleware: () => (_q, _s, n) => n(), enabled: false };
  const app = createBuyApp({ env: { AGENT_PAYOUT_WALLET: PAY_TO_BASE }, paywall, deps: { sanctions: null, trustIndex: null, lure: null, answerCheck: null, filler: { enabled: false }, wallet: null, usageLog: noLog, signer: null, pass: createPassVerifier({ keys: jwks }), vaultStore: store } });
  const base = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
  const pass = proof({ wallets: [OWNER] });
  const buy = () => fetch(`${base}/v1/buy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fizzl-pass': pass }, body: JSON.stringify({ need: 'BTC price' }) });

  const empty = await buy();
  assert.equal(empty.status, 402);
  assert.equal(empty.headers.get('x-fizzl-vault'), 'insufficient');
  assert.equal(walled, 1);

  await store.credit(OWNER, 30000, 100);
  const res = await buy(); // no buying wallet here, so the purchase fails
  assert.ok(res.status >= 400 && res.status !== 402, `status ${res.status}`);
  assert.equal(res.headers.get('x-fizzl-vault'), 'paid');
  assert.equal(walled, 1, 'the paywall was skipped');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await store.balance([OWNER]), 30000, 'given back');
  assert.equal((await (await fetch(`${base}/v1/vault`, { headers: { 'x-fizzl-pass': pass } })).json()).balance_usd, 0.03);
});
