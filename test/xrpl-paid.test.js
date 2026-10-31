// Who gets paid on the XRP Ledger: the hub's merchant names and the endpoints' hosts kept by the daily scan
// (paytos-xrpl.json), the paid payout addresses over the window, and GET /api/trust/payments?network=xrpl. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadXrplHub } = require('../lib/trust-scan');
const { mergeXrplPayTos, XRPL } = require('../lib/onchain-payments-xrpl');
const { sellersOf, createOnchainPayments } = require('../lib/onchain-payments');
const { createApp } = require('../server');

const HEURIST = 'rBi1QrVjwaNofisZAQnovoXdHkS73FG1tJ';
const FIZZL = 'r9xmBsRr8Ao7jRgjjxreMiAwGiCK2FGwqw';
const QUIET = 'rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32';
const DAY1 = '2026-10-25', DAY2 = '2026-10-26';

test('loadXrplHub: the merchant name from its page heading, entities decoded', async () => {
  const pages = {
    '/merchants?page=1': `<a href="/address/${HEURIST}">x</a><a href="/address/${QUIET}">y</a>`,
    [`/address/${HEURIST}`]: '<html><body><h1 class="t">Heurist <span>Inference</span> Router &amp; Co</h1></body></html>',
    [`/address/${QUIET}`]: `<html><body><h1>${QUIET}</h1></body></html>`, // no name of its own
  };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const body = pages[u.pathname + u.search];
    return body ? new Response(body, { status: 200 }) : new Response('not found', { status: 404 });
  };
  const { merchants, names } = await loadXrplHub({ fetchImpl, sleep: async () => {}, pauseMs: 0 });
  assert.deepEqual(merchants.sort(), [HEURIST, QUIET].sort());
  assert.deepEqual(names, { [HEURIST]: 'Heurist Inference Router & Co' });
});

test('mergeXrplPayTos: hub names and the hosts of endpoints paying to each address, dropped with the address', () => {
  const results = [
    { url: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', xrpl_pay_tos: [FIZZL] },
    { url: 'https://x402-doctor.fizzl.eu/api/v1/diagnose', xrpl_pay_tos: [FIZZL] },
    { url: 'https://ichimoku-signal.fizzl.eu/levels/ETH-USDT', xrpl_pay_tos: [FIZZL] },
    { xrpl_pay_tos: [HEURIST, QUIET] }, // the hub's merchants, without an endpoint
  ];
  let m = mergeXrplPayTos(null, results, DAY1, 14, { [HEURIST]: 'Heurist Inference Router', nope: 'x' });
  assert.deepEqual(m.names, { [HEURIST]: 'Heurist Inference Router' });
  assert.deepEqual(m.hosts, { [FIZZL]: ['ichimoku-signal.fizzl.eu', 'x402-doctor.fizzl.eu'] });
  // Another day: Heurist's name stays without a new one; 15 days later an address not seen again goes, name and all.
  m = mergeXrplPayTos(m, [{ xrpl_pay_tos: [HEURIST] }], '2026-10-30');
  assert.equal(m.names[HEURIST], 'Heurist Inference Router');
  assert.deepEqual(m.hosts[FIZZL], ['ichimoku-signal.fizzl.eu', 'x402-doctor.fizzl.eu'], 'hosts kept from an earlier scan');
  m = mergeXrplPayTos(m, [{ url: 'https://x402-doctor.fizzl.eu/x', xrpl_pay_tos: [FIZZL] }], '2026-11-14');
  assert.deepEqual(Object.keys(m.pay_tos), [FIZZL]);
  assert.equal(m.names, undefined);
  assert.deepEqual(m.hosts, { [FIZZL]: ['x402-doctor.fizzl.eu'] });
});

// One complete day: Heurist paid by two wallets with Checks worth $953, Fizzl by a fleet wallet that also paid ten
// other sellers, and an address nobody paid.
function paymentsFile() {
  const fleet = 'rFleetWallet';
  const others = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`rOther${i}`, { since: DAY1, d: { [DAY1]: [1, 10000, [fleet]] } }]));
  return {
    version: 1, network: XRPL, symbol: 'RLUSD or USDC', per_day: 1, updated: `${DAY2}T09:00:00Z`, days: { [DAY1]: { covered: 1 } },
    pay_tos: {
      [HEURIST]: { since: DAY1, d: { [DAY1]: [1935, 953000000, ['rClaw1', 'rClaw2']] } },
      [FIZZL]: { since: DAY1, d: { [DAY1]: [20, 380000, [fleet, 'rLumi']] } },
      [QUIET]: { since: DAY1, d: {} },
      ...others,
    },
  };
}

test('sellersOf: paid payout addresses, most money first, with names, hosts and fleet wallets', () => {
  const info = { names: { [HEURIST]: 'Heurist Inference Router' }, hosts: { [FIZZL]: ['ichimoku-signal.fizzl.eu'] } };
  const list = sellersOf(paymentsFile(), info, { limit: 2 });
  assert.deepEqual([list.network, list.symbol, list.days, list.watched, list.paid, list.wide_sellers], [XRPL, 'RLUSD or USDC', [DAY1], 13, 12, 10]);
  assert.deepEqual(list.sellers, [
    { pay_to: HEURIST, name: 'Heurist Inference Router', hosts: [], payments: 1935, usd: 953, payers: 2, payers_wide: 0 },
    { pay_to: FIZZL, name: null, hosts: ['ichimoku-signal.fizzl.eu'], payments: 20, usd: 0.38, payers: 2, payers_wide: 1 },
  ]);
  assert.equal(sellersOf({ ...paymentsFile(), days: {} }), null, 'no complete day yet');
});

test('GET /api/trust/payments?network=xrpl: the list as JSON, 400 for another network, 503 before a complete day', async () => {
  const info = { network: XRPL, updated: DAY1, pay_tos: {}, names: { [HEURIST]: 'Heurist Inference Router' } };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.includes('paytos-xrpl') ? info : url.includes('payments-xrpl') ? paymentsFile() : { version: 1, network: 'eip155:8453', updated: `${DAY2}T09:00:00Z`, days: {}, pay_tos: {} }) });
  const onchainPayments = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: 'https://x/payments-xrpl.json', xrplPayTosUrl: 'https://x/paytos-xrpl.json', fetchImpl });
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const start = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` })); });
  const { s, base } = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments }));
  try {
    const res = await fetch(`${base}/api/trust/payments?network=xrpl`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.sellers[0].name, 'Heurist Inference Router');
    assert.equal(body.paid, 12);
    assert.equal((await fetch(`${base}/api/trust/payments?network=tron`)).status, 400);
  } finally { s.close(); }
  const empty = createOnchainPayments({ url: 'https://x/payments.json', solanaUrl: '', xrplUrl: 'https://x/payments-xrpl.json', xrplPayTosUrl: '', fetchImpl: async (url) => ({ ok: true, json: async () => (url.includes('xrpl') ? { ...paymentsFile(), days: {} } : { version: 1, updated: `${DAY2}T09:00:00Z`, days: {}, pay_tos: {} }) }) });
  const second = await start(createApp({ allowPrivate: true, env: {}, trustIndex, onchainPayments: empty }));
  try {
    const res = await fetch(`${second.base}/api/trust/payments?network=xrpl`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /no complete day/);
  } finally { second.s.close(); }
});
