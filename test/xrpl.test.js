// XRP Ledger (x402 "exact" on XRPL): address checksum, XRP in drops vs RLUSD in decimals, the RLUSD issuer, and the
// payout account on the ledger (activated, DepositAuth, RequireDestTag, trust line), plus wallets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAccepts, checkXrpl } = require('../lib/diagnose');
const { isXrplAddress } = require('../lib/networks');
const { walletCompatibility } = require('../lib/wallets');

const PAY_TO = 'rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32'; // a real x402 payout account (OnchainPulse listing)
const RLUSD = '524C555344000000000000000000000000000000';
const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De'; // Ripple's RLUSD issuer on mainnet
const xrp = (extra = {}) => ({ scheme: 'exact', network: 'xrpl:0', asset: 'XRP', amount: '15000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: {}, ...extra });
const rlusd = (extra = {}) => ({ scheme: 'exact', network: 'xrpl:0', asset: RLUSD, amount: '0.015', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { issuer: ISSUER }, ...extra });

// A stand-in XRPL node: account_info and account_lines answers by method.
function node({ info, lines = [] }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url, method, params: params[0] });
    const result = method === 'account_info' ? info : { lines };
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  return { fetchImpl, calls };
}
const active = (flags = 0) => ({ account_data: { Account: PAY_TO, Flags: flags, Balance: '4562015' } });

test('addresses: the checksum is verified', () => {
  assert.equal(isXrplAddress(PAY_TO), true);
  assert.equal(isXrplAddress(ISSUER), true);
  assert.equal(isXrplAddress(PAY_TO.slice(0, -1) + '3'), false, 'a changed last character breaks the checksum');
  assert.equal(isXrplAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), false);
});

test('checkAccepts: XRP in drops and Ripple RLUSD pass; decimal XRP and a fake RLUSD issuer are caught', () => {
  const ok = [];
  checkAccepts([xrp(), rlusd()], ok);
  assert.deepEqual(ok.filter((c) => c.status !== 'pass').map((c) => c.id), []);
  assert.match(ok.find((c) => c.id === 'accepts[0]-amount').message, /15000 drops \(0\.015 XRP\)/);
  const bad = [];
  checkAccepts([xrp({ amount: '0.015' }), rlusd({ extra: { issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji' } })], bad);
  const by = Object.fromEntries(bad.map((c) => [c.id, c.status]));
  assert.equal(by['accepts[0]-amount'], 'fail');
  assert.equal(by['accepts[1]-asset'], 'warn');
  assert.match(bad.find((c) => c.id === 'accepts[1]-asset').message, /not the RLUSD stablecoin/);
});

test('checkXrpl: an active account with the RLUSD trust line passes; the node is asked the right things', async () => {
  const n = node({ info: active(), lines: [{ account: ISSUER, currency: RLUSD, balance: '1.2', limit: '1000000' }] });
  const checks = [];
  await checkXrpl([rlusd()], checks, { fetchImpl: n.fetchImpl });
  assert.deepEqual(checks.map((c) => [c.id, c.status]), [['xrpl-payout-account', 'pass'], ['xrpl-payout-trustline', 'pass']]);
  assert.equal(n.calls[0].url, 'https://xrplcluster.com');
  assert.deepEqual(n.calls.map((c) => c.method), ['account_info', 'account_lines']);
  assert.equal(n.calls[1].params.peer, ISSUER);
});

test('checkXrpl: not activated, DepositAuth, RequireDestTag without a tag, no or frozen trust line all fail', async () => {
  const run = async (opts, option = rlusd()) => { const checks = []; await checkXrpl([option], checks, { fetchImpl: node(opts).fetchImpl }); return checks; };
  const missing = await run({ info: { error: 'actNotFound' } });
  assert.equal(missing[0].status, 'fail'); assert.match(missing[0].message, /never activated/); assert.equal(missing.length, 1);
  assert.equal((await run({ info: active(0x01000000), lines: [{ currency: RLUSD }] }))[0].status, 'fail');
  assert.equal((await run({ info: active(0x00020000), lines: [{ currency: RLUSD }] }))[0].status, 'fail');
  assert.equal((await run({ info: active(0x00020000), lines: [{ currency: RLUSD }] }, rlusd({ extra: { issuer: ISSUER, destinationTag: 7 } })))[0].status, 'pass');
  const noLine = await run({ info: active(), lines: [] });
  assert.equal(noLine.find((c) => c.id === 'xrpl-payout-trustline').status, 'fail');
  assert.match(noLine.find((c) => c.id === 'xrpl-payout-trustline').message, /no trust line for RLUSD/);
  assert.equal((await run({ info: active(), lines: [{ currency: RLUSD, freeze: true }] })).find((c) => c.id === 'xrpl-payout-trustline').status, 'fail');
  const xrpOnly = await run({ info: active() }, xrp());
  assert.deepEqual(xrpOnly.map((c) => c.id), ['xrpl-payout-account'], 'XRP needs no trust line');
  const down = []; await checkXrpl([xrp()], down, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(down[0].status, 'info');
});

test('wallets: Xaman, Crossmark, GemWallet and x402 agents pay XRPL; nobody when the payout account cannot receive', () => {
  const w = walletCompatibility([rlusd()], []);
  assert.deepEqual(w.map((x) => x.wallet).sort(), ['Crossmark', 'GemWallet', 'Xaman', 'x402 agents']);
  const blocked = walletCompatibility([rlusd()], [{ id: 'xrpl-payout-trustline', status: 'fail', option: 0 }]);
  assert.ok(blocked.every((x) => x.yes.length === 0));
});
