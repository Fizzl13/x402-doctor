// The OFAC SDN screen of payout addresses (lib/sanctions.js) in the pre-payment check and the daily Trust Index
// scan, against local sellers and a stand-in list. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSafeFetch } = require('../lib/safe-fetch');
const { preflight } = require('../lib/preflight');
const { createSanctions, addressKey } = require('../lib/sanctions');
const { scan, summarize, mergeIndex } = require('../lib/trust-scan');

const BASE = 'eip155:8453';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CLEAN = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
// A made-up listed address (stand-in list), written mixed-case in the 402 to check the EVM match ignores case.
const LISTED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const LIST = {
  list: 'OFAC SDN',
  published: '2026-10-09',
  addresses: [
    { address: LISTED.toLowerCase(), entries: [{ uid: 1, name: 'TEST ENTITY', type: 'Entity', programs: ['CYBER2'], currency: 'ETH' }] },
    { address: 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81', entries: [{ uid: 2, name: 'TRON ENTITY', programs: ['SDGT'] }] },
  ],
};

const servers = [];
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    servers.push(server);
  });
}
test.after(() => servers.forEach((s) => s.close()));

const option = (payTo) => ({ scheme: 'exact', network: BASE, amount: '10000', asset: USDC_BASE, payTo, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } });
async function seller(accepts) {
  let origin;
  origin = await listen((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/openapi.json') { res.statusCode = 404; return res.end('{}'); }
    const challenge = { x402Version: 2, resource: { url: `${origin}${req.url.split('?')[0]}`, mimeType: 'application/json', description: 'x' }, accepts };
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  return `${origin}/paid`;
}

const safeFetch = createSafeFetch({ allowPrivate: true });
const run = (url, sanctions) => preflight(url, { safeFetch, rpcUrl: 'http://127.0.0.1:1', bazaarIndex: { lookup: async () => ({ resource: true, origin: true }) }, sanctions });

test('the list: exact match, EVM and bech32 ignore case, base58 does not; off under node --test unless a list is given', async () => {
  const s = createSanctions({ list: LIST });
  assert.equal(s.check(LISTED).listed, true);
  assert.equal(s.check(LISTED.toLowerCase()).entries[0].name, 'TEST ENTITY');
  assert.equal(s.check(CLEAN).listed, false);
  assert.equal(s.check('TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81').listed, true);
  assert.equal(s.check('tniq9axbp9ejuqhdhrwrfvaa8u3gquzh81').listed, false);
  assert.equal(addressKey('BC1QXYZ'), 'bc1qxyz');
  assert.deepEqual(s.status(), { enabled: true, addresses: 2, published: '2026-10-09' });
  // The suite itself must never download the real list.
  assert.equal(createSanctions().enabled, false);
  assert.equal(createSanctions({ env: {} }).enabled, false);
  assert.equal(createSanctions({ env: { SANCTIONS: 'off' } }).enabled, false);
});

test('a listed payTo: no_go payto_sanctioned first, the option unpayable, the SDN entry named', async () => {
  const url = await seller([option(LISTED)]);
  const r = await run(url, createSanctions({ list: LIST }));
  assert.equal(r.verdict, 'no_go');
  assert.equal(r.safe_to_pay, false);
  assert.equal(r.reasons[0].code, 'payto_sanctioned');
  assert.match(r.summary, /^Do not pay: The seller's payout address 0xAbCd.* \(Base\) is on the OFAC SDN sanctions list: TEST ENTITY \(CYBER2\)/);
  assert.equal(r.options[0].payable, false);
  assert.match(r.options[0].problems[0], /OFAC SDN/);
  assert.deepEqual(r.signals.sanctions, { list: 'OFAC SDN', published: '2026-10-09', screened: 1, listed: [{ option: 0, network: BASE, pay_to: LISTED, entries: [{ name: 'TEST ENTITY', programs: ['CYBER2'] }] }] });
});

test('one listed option among clean ones still makes the seller no_go', async () => {
  const url = await seller([option(CLEAN), option(LISTED)]);
  const r = await run(url, createSanctions({ list: LIST }));
  assert.equal(r.verdict, 'no_go');
  assert.deepEqual(r.reasons.filter((x) => x.level === 'no_go').map((x) => x.code), ['payto_sanctioned']);
  assert.equal(r.options[0].payable, true);
  assert.equal(r.options[1].payable, false);
});

test('a clean payTo: verdict unchanged, signals.sanctions says what was screened', async () => {
  const url = await seller([option(CLEAN)]);
  const r = await run(url, createSanctions({ list: LIST }));
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  assert.deepEqual(r.signals.sanctions, { list: 'OFAC SDN', published: '2026-10-09', screened: 1, listed: [] });
});

test('no list to be had: nothing judged, unavailable in the signals; screening off: no signal at all', async () => {
  const url = await seller([option(LISTED)]);
  const down = createSanctions({ env: {}, fetchImpl: async () => new Response('nope', { status: 503 }) });
  const r = await run(url, down);
  assert.equal(r.verdict, 'go', JSON.stringify(r.reasons));
  assert.deepEqual(r.signals.sanctions, { list: 'OFAC SDN', unavailable: true });
  assert.equal(down.status().lastError, 'HTTP 503');
  const off = await run(url, createSanctions());
  assert.equal(off.signals.sanctions, undefined);
});

test('the list is fetched once with a Doctor user-agent and refreshed when stale', async () => {
  const calls = [];
  let t = 0;
  const s = createSanctions({ env: {}, now: () => t, fetchImpl: async (u, o) => { calls.push([u, o.headers['user-agent']]); return Response.json(LIST); } });
  assert.equal((await s.ready()).count, 2);
  assert.equal((await s.ready()).count, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://presign-guard.fizzl.eu/v1/sanctions');
  assert.match(calls[0][1], /^x402-doctor\/\d+\.\d+\.\d+ \(sanctions list/);
  t = 7 * 60 * 60 * 1000;
  await s.ready();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2);
});

test('Trust Index scan: x402 and MPP payouts screened, summary counts them', async () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const soon = new Date(Date.now() + 300_000).toISOString();
  const mppReq = (recipient) => b64u({ amount: '10000', currency: USDC_BASE, recipient, methodDetails: { chainId: 8453, decimals: 6 } });
  const x402 = await seller([option(LISTED)]);
  const api = await listen((req, res) => {
    res.statusCode = 402;
    const recipient = req.url === '/mpp-listed' ? LISTED : CLEAN;
    res.setHeader('www-authenticate', `Payment id="1", realm="127.0.0.1", method="evm", intent="charge", request="${mppReq(recipient)}", expires="${soon}"`);
    res.end();
  });
  const entries = [
    { key: x402, url: x402, method: 'GET' },
    { key: `${api}/mpp-listed`, url: `${api}/mpp-listed`, method: 'GET', p: 'mpp' },
    { key: `${api}/mpp-clean`, url: `${api}/mpp-clean`, method: 'GET', p: 'mpp' },
  ];
  const results = await scan(entries, { safeFetch, rpcUrl: 'http://127.0.0.1:1', sanctions: createSanctions({ list: LIST }) });
  const by = Object.fromEntries(results.map((r) => [r.url.split('/').pop(), r]));
  assert.equal(by.paid.verdict, 'no_go');
  assert.ok(by.paid.codes.includes('payto_sanctioned'));
  assert.equal(by['mpp-listed'].verdict, 'no_go');
  assert.deepEqual(by['mpp-listed'].codes, ['payto_sanctioned']);
  assert.equal(by['mpp-clean'].verdict, 'go');
  const summary = summarize(mergeIndex(null, results, { date: '2026-10-12' }));
  assert.equal(summary.payto_sanctioned, 2);
});
