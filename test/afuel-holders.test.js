// $AFUEL holder tiers (lib/afuel-holders.js): a signed wallet that holds Bronze or more gets a few paid calls a day
// free, counted per wallet and capped for all holders together; everything else still answers 402.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createApp } = require('../server');
const { b58decode, verifyWalletSignature, tierFor } = require('../lib/afuel-holders');

const PAY_TO_BASE = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const PAY_TO_SOLANA = 'ATWJ82T8nRdQwZnaysB68N5EpaSvLRsQP4h6eWmaJBH9';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = `1${out}`; }
  return out;
};

function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const address = b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const sign = (ts = Math.floor(Date.now() / 1000)) => ({
    'x-wallet': address,
    'x-wallet-timestamp': String(ts),
    'x-wallet-signature': b58(crypto.sign(null, Buffer.from(`agent-coin-api:${ts}`), privateKey)),
  });
  return { address, sign };
}

const servers = [];
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  servers.push(s);
});
test.after(() => servers.forEach((s) => s.close()));

const gold = wallet();
const bronze = wallet();
const small = wallet();
const holdings = { [gold.address]: 1_500_000n, [bronze.address]: 100_000n, [small.address]: 99_999n };
let rpcUrl;
let target;
let facilitatorUrl;
let rpcCalls = 0;
test.before(async () => {
  rpcUrl = await listen(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const { method, params } = JSON.parse(raw);
    rpcCalls += 1;
    res.setHeader('content-type', 'application/json');
    if (method !== 'getTokenAccountsByOwner') return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'unexpected' } }));
    const whole = holdings[params[0]] ?? 0n;
    const value = whole ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(whole * 10n ** 6n) } } } } } }] : [];
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }));
  });
  // A facilitator that supports USDC on Base and Solana, so Doctor can build its 402.
  facilitatorUrl = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' } }],
      extensions: [],
      signers: {},
    }));
  });
  // The endpoint Doctor checks: a plain 402 with one USDC option on Base.
  target = await listen((req, res) => {
    res.statusCode = 402;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1000', resource: 'http://x', payTo: PAY_TO_BASE, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxTimeoutSeconds: 60 }] }));
  });
});

async function start(extraEnv) {
  const env = { AGENT_PAYOUT_WALLET: PAY_TO_BASE, AGENT_PAYOUT_WALLET_SOLANA: PAY_TO_SOLANA, FACILITATOR_URL: facilitatorUrl, DOCTOR_WARM_BAZAAR_INDEX: '0', AFUEL_PAYMENTS: 'on', AFUEL_USD_PRICE: '0.000003', SOLANA_RPC_URL: rpcUrl, ...extraEnv };
  const app = createApp({ allowPrivate: true, env, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}

const preflight = (api, headers) => fetch(`${api}/api/v1/preflight?url=${encodeURIComponent(`${target}/paid`)}`, { headers });

test('signature, base58 and tiers', () => {
  const w = wallet();
  const h = w.sign(1_700_000_000);
  assert.equal(b58decode(w.address).length, 32);
  assert.ok(verifyWalletSignature(h['x-wallet'], h['x-wallet-timestamp'], h['x-wallet-signature'], 1_700_000_100));
  assert.ok(!verifyWalletSignature(h['x-wallet'], h['x-wallet-timestamp'], h['x-wallet-signature'], 1_700_000_400), 'older than 5 minutes');
  assert.ok(!verifyWalletSignature(h['x-wallet'], '1700000001', h['x-wallet-signature'], 1_700_000_100), 'other timestamp');
  assert.ok(!verifyWalletSignature(gold.address, h['x-wallet-timestamp'], h['x-wallet-signature'], 1_700_000_100), 'other wallet');
  assert.ok(!verifyWalletSignature('0OIl', '1', 'x', 1));
  assert.equal(tierFor(99_999n * 10n ** 6n), null);
  assert.equal(tierFor(100_000n * 10n ** 6n).name, 'bronze');
  assert.equal(tierFor(250_000n * 10n ** 6n).name, 'silver');
  assert.equal(tierFor(1_000_000n * 10n ** 6n).name, 'gold');
});

test('a signed Gold wallet gets the preflight free; the fix stays paid; others get the 402 with the reason', async () => {
  const api = await start({});
  const free = await preflight(api, gold.sign());
  assert.equal(free.status, 200);
  assert.equal(free.headers.get('x-afuel-holder'), 'free');
  assert.equal(free.headers.get('x-afuel-tier'), 'gold');
  assert.equal(free.headers.get('x-afuel-free-remaining'), '499');
  assert.equal((await preflight(api, gold.sign())).headers.get('x-afuel-free-remaining'), '498');

  const fix = await fetch(`${api}/api/v1/fix?url=${encodeURIComponent(`${target}/paid`)}`, { headers: gold.sign() });
  assert.equal(fix.status, 402, 'the $0.05 fix is not free');

  const below = await preflight(api, small.sign());
  assert.equal(below.status, 402);
  assert.equal(below.headers.get('x-afuel-holder'), 'below_bronze');

  const forged = { ...gold.sign(), 'x-wallet-signature': bronze.sign()['x-wallet-signature'] };
  const bad = await preflight(api, forged);
  assert.equal(bad.status, 402);
  assert.equal(bad.headers.get('x-afuel-holder'), 'invalid_signature');

  assert.equal((await preflight(api, {})).status, 402, 'no headers: the normal 402');
});

test('Bronze has 20 a day, and all holders together stop at the daily cap', async () => {
  const api = await start({ AFUEL_HOLDER_DAILY_CAP: '22' });
  for (let i = 0; i < 20; i++) assert.equal((await preflight(api, bronze.sign())).status, 200, `bronze call ${i + 1}`);
  const used = await preflight(api, bronze.sign());
  assert.equal(used.status, 402);
  assert.equal(used.headers.get('x-afuel-holder'), 'used_up');
  assert.equal((await preflight(api, gold.sign())).status, 200);
  assert.equal((await preflight(api, gold.sign())).status, 200);
  const capped = await preflight(api, gold.sign());
  assert.equal(capped.status, 402);
  assert.equal(capped.headers.get('x-afuel-holder'), 'daily_cap');
});

test('the balance is cached a minute per wallet', async () => {
  const api = await start({});
  const before = rpcCalls;
  const w = wallet();
  holdings[w.address] = 300_000n;
  for (let i = 0; i < 3; i++) assert.equal((await preflight(api, w.sign())).status, 200);
  assert.equal(rpcCalls - before, 1);
});

test('GET /api/v1/afuel/holder: the tiers, and with headers the wallet\'s tier and calls left', async () => {
  const api = await start({});
  const info = await (await fetch(`${api}/api/v1/afuel/holder`)).json();
  assert.deepEqual(info.tiers.map((t) => [t.tier, t.min_afuel, t.free_calls_per_day]), [['gold', 1_000_000, 500], ['silver', 250_000, 100], ['bronze', 100_000, 20]]);
  assert.equal(info.on, true);
  const w = wallet();
  holdings[w.address] = 260_000n;
  const mine = await (await fetch(`${api}/api/v1/afuel/holder`, { headers: w.sign() })).json();
  assert.equal(mine.tier, 'silver');
  assert.equal(mine.free_calls_left_today, 100);
  const bad = await fetch(`${api}/api/v1/afuel/holder`, { headers: { ...w.sign(), 'x-wallet-timestamp': '1' } });
  assert.equal(bad.status, 401);
});

test('off without AFUEL_PAYMENTS=on, or with AFUEL_HOLDERS=off', async () => {
  for (const env of [{ AFUEL_PAYMENTS: '' }, { AFUEL_HOLDERS: 'off' }]) {
    const api = await start(env);
    const res = await preflight(api, gold.sign());
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('x-afuel-holder'), null);
  }
});
