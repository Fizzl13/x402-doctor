const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { keccak256, stringToHex, getAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { createMppPay, unlessMppPaid, atomicUsdc, BASE_USDC } = require('../lib/mpp-pay');
const { parseChallenges } = require('../lib/mpp');

const PAY_TO = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const agent = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const quiet = { warn() {} };

// A paid route behind MPP and a stand-in for the x402 paywall, with a fake facilitator.
function serve({ verify = { isValid: true }, settle = { success: true, transaction: '0xabc', payer: agent.address }, status = 200 } = {}) {
  const calls = { verify: 0, settle: 0, x402: 0 };
  const facilitator = {
    async verify(payload, req) { calls.verify++; calls.payload = payload; calls.requirements = req; return verify; },
    async settle() { calls.settle++; return settle; },
  };
  const mpp = createMppPay({ secret: 'test-secret', realm: 'doctor.test', recipient: PAY_TO, routes: { 'GET /paid': '$0.01' }, facilitator, log: quiet });
  const app = express();
  app.use(mpp.middleware);
  app.use(unlessMppPaid((req, res, next) => {
    if (req.path !== '/paid') return next();
    calls.x402++;
    res.status(402).json({ x402Version: 2, accepts: [] });
  }));
  app.get('/paid', (req, res) => res.status(status).json({ ok: status === 200, locals: res.locals.mppPayment || null }));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => resolve({ base: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() }));
  });
}

// What an mppx evm client sends for a challenge.
async function credentialFor(challenge, { value, nonce, to = challenge.request.recipient } = {}) {
  const n = nonce || keccak256(stringToHex(JSON.stringify([challenge.id, challenge.realm])));
  const validBefore = String(Math.floor(Date.parse(challenge.expires) / 1000));
  const v = value || challenge.request.amount;
  const signature = await agent.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: challenge.request.currency },
    types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'TransferWithAuthorization',
    message: { from: agent.address, to, value: BigInt(v), validAfter: 0n, validBefore: BigInt(validBefore), nonce: n },
  });
  const { request, ...rest } = challenge;
  const wire = { challenge: { ...rest, request: challenge.requestRaw }, payload: { type: 'authorization', from: agent.address, to, value: v, validAfter: '0', validBefore, nonce: n, signature }, source: `did:pkh:eip155:8453:${agent.address}` };
  return `Payment ${Buffer.from(JSON.stringify(wire)).toString('base64url')}`;
}

async function challengeFrom(base) {
  const res = await fetch(`${base}/paid`);
  assert.equal(res.status, 402);
  const [{ params, request }] = parseChallenges(res.headers.get('www-authenticate'));
  return { ...params, request, requestRaw: params.request };
}

test('atomicUsdc turns a $ price into 6-decimal units', () => {
  assert.equal(atomicUsdc('$0.01'), '10000');
  assert.equal(atomicUsdc('$0.001'), '1000');
  assert.equal(atomicUsdc('1.5'), '1500000');
  assert.throws(() => atomicUsdc('ten'));
});

test('the 402 carries an MPP evm challenge next to x402', async (t) => {
  const s = await serve(); t.after(s.close);
  const c = await challengeFrom(s.base);
  assert.equal(c.method, 'evm');
  assert.equal(c.intent, 'charge');
  assert.equal(c.realm, 'doctor.test');
  assert.deepEqual(c.request, { amount: '10000', currency: BASE_USDC, methodDetails: { chainId: 8453, credentialTypes: ['authorization'], decimals: 6 }, recipient: PAY_TO });
  assert.ok(Date.parse(c.expires) > Date.now());
  assert.equal(s.calls.x402, 1);
});

test('a valid credential is verified, served, then settled, with a receipt', async (t) => {
  const s = await serve(); t.after(s.close);
  const c = await challengeFrom(s.base);
  const res = await fetch(`${s.base}/paid`, { headers: { authorization: await credentialFor(c) } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.locals, null); // set when settled, after the handler
  assert.equal(s.calls.x402, 1); // only for the first, unpaid request
  assert.equal(s.calls.verify, 1);
  assert.equal(s.calls.settle, 1);
  assert.equal(s.calls.requirements.network, 'eip155:8453');
  assert.equal(s.calls.requirements.amount, '10000');
  assert.equal(s.calls.payload.payload.authorization.from, agent.address);
  const receipt = JSON.parse(Buffer.from(res.headers.get('payment-receipt'), 'base64url').toString());
  assert.equal(receipt.method, 'evm');
  assert.equal(receipt.reference, '0xabc');
  assert.equal(receipt.status, 'success');
});

test('a failed answer is never settled', async (t) => {
  const s = await serve({ status: 502 }); t.after(s.close);
  const c = await challengeFrom(s.base);
  const res = await fetch(`${s.base}/paid`, { headers: { authorization: await credentialFor(c) } });
  assert.equal(res.status, 502);
  assert.equal(s.calls.settle, 0);
  assert.equal(res.headers.get('payment-receipt'), null);
});

test('refuses a tampered challenge, wrong amount, wrong nonce or wrong recipient', async (t) => {
  const s = await serve(); t.after(s.close);
  const c = await challengeFrom(s.base);
  const cases = [
    [{ ...c, id: c.id.replace(/^./, (x) => (x === 'A' ? 'B' : 'A')) }, {}, /issued here/],
    [{ ...c, expires: new Date(Date.now() + 3600e3).toISOString() }, {}, /issued here/],
    [c, { value: '1' }, /another amount/],
    [c, { nonce: `0x${'11'.repeat(32)}` }, /nonce/],
    [c, { to: agent.address }, /someone else/],
  ];
  for (const [ch, opts, re] of cases) {
    const res = await fetch(`${s.base}/paid`, { headers: { authorization: await credentialFor(ch, opts) } });
    assert.equal(res.status, 402);
    assert.match((await res.json()).detail, re);
    assert.ok(res.headers.get('www-authenticate').startsWith('Payment '));
  }
  assert.equal(s.calls.verify, 0);
});

test('refuses when the facilitator says no or settlement fails', async (t) => {
  const s = await serve({ verify: { isValid: false, invalidReason: 'insufficient_funds' } }); t.after(s.close);
  let res = await fetch(`${s.base}/paid`, { headers: { authorization: await credentialFor(await challengeFrom(s.base)) } });
  assert.equal(res.status, 402);
  assert.match((await res.json()).detail, /insufficient_funds/);
  const s2 = await serve({ settle: { success: false, errorReason: 'nonce_used' } }); t.after(s2.close);
  res = await fetch(`${s2.base}/paid`, { headers: { authorization: await credentialFor(await challengeFrom(s2.base)) } });
  assert.equal(res.status, 402);
  assert.match((await res.json()).detail, /nonce_used/);
});

test('Doctor\'s own MPP check reads the challenge without errors', async (t) => {
  const s = await serve(); t.after(s.close);
  const { checkMpp } = require('../lib/mpp');
  const res = await fetch(`${s.base}/paid`);
  const checks = [];
  const safeFetch = (u, o) => fetch(u, o);
  await checkMpp({ res, url: `${s.base}/paid`, method: 'GET', safeFetch }, checks);
  const bad = checks.filter((x) => x.status === 'fail' && x.id !== 'mpp-realm');
  assert.deepEqual(bad, []);
});

test('routes with parameters match, and an answer that bypasses res.send is refused, not served unpaid', async (t) => {
  const calls = { settle: 0 };
  const facilitator = { async verify() { return { isValid: true }; }, async settle() { calls.settle++; return { success: true, transaction: '0x1' }; } };
  const mpp = createMppPay({ secret: 's', realm: 'doctor.test', recipient: PAY_TO, routes: { 'GET /signal/:pair': '$0.02', 'GET /raw': '$0.01' }, facilitator, log: quiet });
  const app = express();
  app.use(mpp.middleware);
  app.use(unlessMppPaid((req, res, next) => (req.path === '/free' ? next() : res.status(402).json({}))));
  app.get('/signal/:pair', (req, res) => res.type('text').send(`signal ${req.params.pair}`));
  app.get('/raw', (req, res) => { res.status(200); res.end('raw'); });
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const [{ params, request }] = parseChallenges((await fetch(`${base}/signal/BTC-USDT`)).headers.get('www-authenticate'));
  assert.equal(request.amount, '20000');
  const c = { ...params, request, requestRaw: params.request };
  let res = await fetch(`${base}/signal/BTC-USDT`, { headers: { authorization: await credentialFor(c) } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'signal BTC-USDT');
  assert.ok(res.headers.get('payment-receipt'));
  assert.equal(calls.settle, 1);

  const raw = parseChallenges((await fetch(`${base}/raw`)).headers.get('www-authenticate'))[0];
  res = await fetch(`${base}/raw`, { headers: { authorization: await credentialFor({ ...raw.params, request: raw.request, requestRaw: raw.params.request }) } });
  assert.equal(res.status, 402);
  assert.equal(calls.settle, 1);
});

test('a challenge from another service with the same secret and route is refused', async (t) => {
  const s = await serve(); t.after(s.close);
  const facilitator = { async verify() { return { isValid: true }; }, async settle() { return { success: true }; } };
  const other = createMppPay({ secret: 'test-secret', realm: 'other.test', recipient: PAY_TO, routes: { 'GET /paid': '$0.01' }, facilitator, log: quiet });
  const oc = other.challengeFor('GET /paid');
  const c = { ...oc, requestRaw: Buffer.from(require('../lib/mpp-pay').canonical(oc.request)).toString('base64url') };
  const res = await fetch(`${s.base}/paid`, { headers: { authorization: await credentialFor(c) } });
  assert.equal(res.status, 402);
  assert.match((await res.json()).detail, /another service/);
  assert.equal(s.calls.verify, 0);
});

// Tempo (push mode): the agent pays on Tempo itself and sends the hash; a fake RPC holds the receipts.
const TEMPO_PAY_TO = '0x1111111111111111111111111111111111111111';
const TEMPO_USDC = getAddress('0x20c000000000000000000000b9537d11c60e8b50');
const TOPIC = keccak256(stringToHex('TransferWithMemo(address,address,uint256,bytes32)'));
const pad = (addr) => `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`;
// The mppx memo: keccak("mpp")[0:4], 01, keccak(realm)[0:10], client [10], keccak(id)[0:7].
const memoFor = (realm, id) => `0x${keccak256(stringToHex('mpp')).slice(2, 10)}01${keccak256(stringToHex(realm)).slice(2, 22)}${'0'.repeat(20)}${keccak256(stringToHex(id)).slice(2, 16)}`;
const transferLog = ({ from = agent.address, to = TEMPO_PAY_TO, amount = 10000n, memo, token = TEMPO_USDC }) => ({
  address: token.toLowerCase(), topics: [TOPIC, pad(from), pad(to), memo], data: `0x${amount.toString(16).padStart(64, '0')}`,
});

function serveTempo({ status = 200, rpcDown = false } = {}) {
  const receipts = new Map();
  const calls = { x402: 0, handler: 0 };
  const mpp = createMppPay({
    secret: 'test-secret', realm: 'doctor.test', recipient: PAY_TO, routes: { 'GET /paid': '$0.01' },
    facilitator: { async verify() { return { isValid: true }; }, async settle() { return { success: true, transaction: '0xabc' }; } },
    tempo: { recipient: TEMPO_PAY_TO, getReceipt: async (hash) => { if (rpcDown) throw new Error('down'); return receipts.get(hash) || null; } },
    log: quiet,
  });
  const app = express();
  app.use(mpp.middleware);
  app.use(unlessMppPaid((req, res, next) => { if (req.path !== '/paid') return next(); calls.x402++; res.status(402).json({ x402Version: 2, accepts: [] }); }));
  app.get('/paid', (req, res) => { calls.handler++; res.on('finish', () => { calls.locals = res.locals.mppPayment; }); res.status(status).json({ ok: status === 200, locals: res.locals.mppPayment || null }); });
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => resolve({ base: `http://127.0.0.1:${server.address().port}`, receipts, calls, mpp, close: () => server.close() }));
  });
}

async function tempoChallenge(base) {
  const res = await fetch(`${base}/paid`);
  assert.equal(res.status, 402);
  const all = parseChallenges(res.headers.get('www-authenticate'));
  const t = all.find((c) => c.params.method === 'tempo');
  return { ...t.params, request: t.request, requestRaw: t.params.request, all };
}
const tempoCredential = (c, hash, { source = `did:pkh:eip155:4217:${agent.address}`, type = 'hash' } = {}) => {
  const { request, requestRaw, all, ...rest } = c;
  return `Payment ${Buffer.from(JSON.stringify({ challenge: { ...rest, request: requestRaw }, payload: { hash, type }, ...(source ? { source } : {}) })).toString('base64url')}`;
};
const HASH = `0x${'ab'.repeat(32)}`;

test('the 402 offers tempo (push only, USDC.e on chain 4217) next to evm', async (t) => {
  const s = await serveTempo();
  t.after(s.close);
  const c = await tempoChallenge(s.base);
  assert.deepEqual(c.all.map((x) => x.params.method), ['evm', 'tempo']);
  assert.deepEqual(c.request, { amount: '10000', currency: TEMPO_USDC, methodDetails: { chainId: 4217, supportedModes: ['push'] }, recipient: TEMPO_PAY_TO });
  assert.equal(s.mpp.tempo.network, 'Tempo');
});

test('a Tempo hash with the bound memo is served once, with a receipt', async (t) => {
  const s = await serveTempo();
  t.after(s.close);
  const c = await tempoChallenge(s.base);
  s.receipts.set(HASH, { status: '0x1', from: agent.address.toLowerCase(), logs: [transferLog({ memo: memoFor('doctor.test', c.id) })] });
  const auth = tempoCredential(c, HASH);
  const res = await fetch(`${s.base}/paid`, { headers: { authorization: auth } });
  assert.equal(res.status, 200);
  await res.json();
  assert.deepEqual(s.calls.locals, { usd: 0.01, network: 'Tempo', payer: agent.address, tx: HASH, protocol: 'mpp' });
  const receipt = JSON.parse(Buffer.from(res.headers.get('payment-receipt'), 'base64url').toString());
  assert.equal(receipt.method, 'tempo');
  assert.equal(receipt.reference, HASH);
  assert.equal(s.calls.x402, 1); // only the first, unpaid request
  const again = await fetch(`${s.base}/paid`, { headers: { authorization: auth } });
  assert.equal(again.status, 402);
  assert.match((await again.json()).detail, /already paid/);
});

test('a failed answer frees the hash, so the same credential can be sent again', async (t) => {
  const s = await serveTempo({ status: 500 });
  t.after(s.close);
  const c = await tempoChallenge(s.base);
  s.receipts.set(HASH, { status: '0x1', from: agent.address, logs: [transferLog({ memo: memoFor('doctor.test', c.id) })] });
  const auth = tempoCredential(c, HASH);
  assert.equal((await fetch(`${s.base}/paid`, { headers: { authorization: auth } })).status, 500);
  assert.equal((await fetch(`${s.base}/paid`, { headers: { authorization: auth } })).status, 500);
  assert.equal(s.calls.handler, 2);
});

test('refuses Tempo payments that pay the wrong amount, recipient, token, payer or challenge', async (t) => {
  const s = await serveTempo();
  t.after(s.close);
  const c = await tempoChallenge(s.base);
  const memo = memoFor('doctor.test', c.id);
  const cases = {
    amount: transferLog({ memo, amount: 9999n }),
    recipient: transferLog({ memo, to: PAY_TO }),
    token: transferLog({ memo, token: '0x20c0000000000000000000000000000000000000' }),
    payer: transferLog({ memo, from: TEMPO_PAY_TO }),
    otherChallenge: transferLog({ memo: memoFor('doctor.test', 'another-id') }),
    otherRealm: transferLog({ memo: memoFor('other.test', c.id) }),
  };
  let i = 0;
  for (const [name, log] of Object.entries(cases)) {
    const hash = `0x${String(++i).padStart(64, '0')}`;
    s.receipts.set(hash, { status: '0x1', from: agent.address, logs: [log] });
    const res = await fetch(`${s.base}/paid`, { headers: { authorization: tempoCredential(c, hash) } });
    assert.equal(res.status, 402, name);
    assert.match((await res.json()).detail, /No transfer/, name);
  }
  const reverted = `0x${'cd'.repeat(32)}`;
  s.receipts.set(reverted, { status: '0x0', from: agent.address, logs: [transferLog({ memo })] });
  assert.match((await (await fetch(`${s.base}/paid`, { headers: { authorization: tempoCredential(c, reverted) } })).json()).detail, /failed on Tempo/);
  assert.match((await (await fetch(`${s.base}/paid`, { headers: { authorization: tempoCredential(c, `0x${'ee'.repeat(32)}`) } })).json()).detail, /isn't on Tempo/);
  assert.match((await (await fetch(`${s.base}/paid`, { headers: { authorization: tempoCredential(c, HASH, { type: 'transaction' }) } })).json()).detail, /push mode/);
  assert.match((await (await fetch(`${s.base}/paid`, { headers: { authorization: tempoCredential(c, HASH, { source: `did:pkh:eip155:8453:${agent.address}` }) } })).json()).detail, /source must be/);
  assert.equal(s.calls.handler, 0);
});

test('without a source the transaction sender is the payer; an RPC outage is retryable', async (t) => {
  const s = await serveTempo();
  t.after(s.close);
  const c = await tempoChallenge(s.base);
  s.receipts.set(HASH, { status: '0x1', from: agent.address, logs: [transferLog({ memo: memoFor('doctor.test', c.id) })] });
  assert.equal((await fetch(`${s.base}/paid`, { headers: { authorization: tempoCredential(c, HASH, { source: null }) } })).status, 200);
  const down = await serveTempo({ rpcDown: true });
  t.after(down.close);
  const c2 = await tempoChallenge(down.base);
  const res = await fetch(`${down.base}/paid`, { headers: { authorization: tempoCredential(c2, HASH) } });
  assert.equal(res.status, 402);
  assert.match((await res.json()).detail, /could not be checked right now/);
});

test('Doctor\'s own MPP check reads both challenges (evm and tempo) without errors', async (t) => {
  const s = await serveTempo(); t.after(s.close);
  const { checkMpp } = require('../lib/mpp');
  const res = await fetch(`${s.base}/paid`);
  const checks = [];
  await checkMpp({ res, url: `${s.base}/paid`, method: 'GET', safeFetch: (u, o) => fetch(u, o) }, checks);
  assert.deepEqual(checks.filter((x) => x.status === 'fail' && x.id !== 'mpp-realm'), []);
  assert.ok(checks.some((x) => /tempo/i.test(`${x.message || ''}${x.detail || ''}${x.title || ''}`)), JSON.stringify(checks.map((x) => x.id)));
});

test('offers list tempo next to evm when it is on', () => {
  const { addMppOffers } = require('../lib/mpp-pay');
  const spec = { info: {}, paths: { '/paid': { get: { summary: 'Paid', 'x-payment-info': { price: { mode: 'fixed', amount: '0.01', currency: 'USD' } } } } } };
  addMppOffers(spec, { tempo: { currency: TEMPO_USDC } });
  const info = spec.paths['/paid'].get['x-payment-info'];
  assert.deepEqual(info.offers.map((o) => [o.method, o.currency, o.amount]), [['evm', BASE_USDC, '10000'], ['tempo', TEMPO_USDC, '10000']]);
  assert.deepEqual(info.protocols.map((p) => Object.keys(p)[0]), ['x402', 'mpp', 'mpp']);
});
