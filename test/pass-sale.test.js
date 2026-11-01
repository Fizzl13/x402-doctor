// Fizzl Pass sold over x402 (lib/pass-sale.js): a real x402 payment (mock facilitator), and only after it settled the
// sale is handed to the Agent Wallet; the answer's claim_url is where the buyer's proof will be.
process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm/exact/client');
const { createApp } = require('../server');
const { createPassSale, settledSale } = require('../lib/pass-sale');
const { memoryVault } = require('../lib/fizzl-vault');

const BASE = 'eip155:8453';
const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const servers = [];
const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
const json = (res, v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
async function body(req) { let raw = ''; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }
test.after(() => servers.forEach((s) => s.close()));

async function boot({ settle = true } = {}) {
  const facilitator = await listen(async (req, res) => {
    if (req.url.endsWith('/supported')) return json(res, { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }], extensions: [], signers: {} });
    const { paymentPayload } = await body(req);
    const from = paymentPayload.payload.authorization.from;
    if (req.url.endsWith('/verify')) return json(res, { isValid: true, payer: from });
    return settle ? json(res, { success: true, transaction: `0xsettled${Date.now()}`, network: BASE, payer: from }) : json(res, { success: false, errorReason: 'settle_failed', transaction: '', network: BASE });
  });
  const handedIn = [];
  const passSale = createPassSale({ key: 'a-long-pass-sale-test-value', walletUrl: 'https://wallet.test', retryMs: [], fetchImpl: async (url, init) => { handedIn.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }); } });
  const vault = memoryVault();
  const app = createApp({ allowPrivate: true, env: { AGENT_PAYOUT_WALLET: PAY_TO, FACILITATOR_URL: facilitator, PASS_STATUS_URL: 'http://127.0.0.1:1/s' }, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, creditStore: null, vaultStore: vault, passSale });
  const api = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
  return { api, handedIn, vault };
}

test('free info lists the tiers; unpaid gets the 402 at the tier price', async () => {
  const { api } = await boot();
  const info = await (await fetch(`${api}/api/v1/pass`)).json();
  assert.equal(info.on_sale, true);
  assert.deepEqual(Object.keys(info.tiers), ['bronze', 'silver', 'gold']);
  const res = await fetch(`${api}/api/v1/pass/silver`);
  assert.equal(res.status, 402);
  const ch = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString());
  assert.equal(ch.accepts.find((a) => a.network === BASE).amount, '20000000');
  assert.equal((await fetch(`${api}/api/v1/pass/platinum`)).status, 404);
});

test('a paid Silver: claim_url back, the sale handed to the wallet after it settled, no credit back on it', async () => {
  const { api, handedIn, vault } = await boot();
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(account));
  client.setSpendControls(false); // @x402/fetch pays at most $1 a payment unless raised
  const res = await wrapFetchWithPayment(fetch, client)(`${api}/api/v1/pass/silver`);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.match(out.claim_url, /^https:\/\/wallet\.test\/v1\/pass\/claim\/[A-Za-z0-9_-]{32}$/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(handedIn.length, 1);
  assert.equal(handedIn[0].url, 'https://wallet.test/hooks/pass-sale');
  assert.equal(handedIn[0].auth, 'Bearer a-long-pass-sale-test-value');
  assert.deepEqual([handedIn[0].body.wallet, handedIn[0].body.tier, handedIn[0].body.claim], [account.address, 'silver', out.claim_url.split('/').pop()]);
  assert.match(handedIn[0].body.tx, /^0xsettled/);
  assert.equal(await vault.balance([account.address.toLowerCase()]), 0);
});

test('a payment that does not settle grants nothing', async () => {
  const { api, handedIn } = await boot({ settle: false });
  const client = new x402Client((_v, accepts) => accepts.find((a) => a.network === BASE));
  client.register(BASE, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  client.setSpendControls(false);
  const res = await wrapFetchWithPayment(fetch, client)(`${api}/api/v1/pass/gold`);
  assert.notEqual(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(handedIn.length, 0);
});

test('without PASS_SALE_KEY: not on sale, no paid route', async () => {
  const app = createApp({ allowPrivate: true, env: { AGENT_PAYOUT_WALLET: PAY_TO, FACILITATOR_URL: 'http://127.0.0.1:1' }, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) }, creditStore: null, vaultStore: null });
  const api = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)); servers.push(s); });
  assert.equal((await (await fetch(`${api}/api/v1/pass`)).json()).on_sale, false);
  assert.equal((await fetch(`${api}/api/v1/pass/silver`)).status, 503);
  assert.equal(settledSale({ statusCode: 200, locals: {}, getHeader: () => undefined }), null);
});
