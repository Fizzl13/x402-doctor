// Payments for the owner's usage page (lib/usage-payments.js): outside customers apart from our own wallets and tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { paidOf, parseKnown, classify, summarizePayments } = require('../lib/usage-payments');
const { createUsageReader } = require('../lib/usage-reader');

const OWN = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const TEST = '0xc9c7b38C0942914fC8EA12063BC92dcd3b581670';
const known = parseKnown(JSON.stringify({ own_wallets: [OWN], test_payers: { [TEST]: 'vet402-observatory' }, test_agents: 'observatory|harness' }));

test('paidOf keeps paid calls only, cut down to what the page shows', () => {
  const out = paidOf([
    { t: '2026-11-03T10:00:00Z', service: 'doctor', route: 'preflight', paid: true, usd: '0.001', network: 'base', payer: '0xabc', agent: 'node', input: { url: 'secret' } },
    { t: '2026-11-03T10:01:00Z', service: 'doctor', route: 'preflight', paid: false, quote: true },
    { t: '2026-11-03T10:02:00Z', service: 'doctor', route: 'preflight', paid: true, quote: true },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].usd, 0.001);
  assert.equal('input' in out[0], false, 'no inputs leave the summary');
});

test('classify: own wallets and workflows, test payers and agents, everyone else a customer', () => {
  assert.equal(classify({ payer: OWN.toLowerCase() }, known).kind, 'own');
  assert.equal(classify({ payer: '0xA128', agent: 'x402-doctor-buy-check/1.0' }, known).kind, 'own');
  assert.equal(classify({ payer: 'GCNX', agent: 'fizzl-monitor/stellar-smoke' }, known).kind, 'own');
  assert.equal(classify({ payer: TEST }, known).why, 'vet402-observatory');
  assert.equal(classify({ payer: '0x1', agent: 'usetested-harness/2' }, known).kind, 'test');
  assert.equal(classify({ payer: '0x2', agent: 'node' }, known).kind, 'outside');
  assert.equal(classify({ payer: '0x2' }, parseKnown('not json')).kind, 'outside', 'a broken known.json counts everyone as outside');
});

test('summarizePayments: today, 7 days and the range per kind; one row per outside payer; whole range, not cut off', () => {
  const now = Date.parse('2026-11-03T21:00:00Z');
  const files = [
    { summary: paidOf([
      { t: '2026-11-03T12:58:00Z', service: 'buy', route: 'buy', paid: true, usd: 0.02, network: 'base', payer: '0xA128', agent: 'x402-doctor-buy-check/1.0' },
      { t: '2026-11-03T09:00:00Z', service: 'ichimoku', route: 'signal', paid: true, usd: 0.01, network: 'xrpl', payer: 'rCust', agent: 'python-requests/2' },
    ]) },
    { summary: paidOf([
      { t: '2026-10-30T09:00:00Z', service: 'presign', route: 'check', paid: true, usd: 0.01, network: 'base', payer: 'rCust', agent: 'python-requests/2' },
      { t: '2026-10-20T09:00:00Z', service: 'doctor', route: 'preflight', paid: true, usd: 0.001, network: 'base', payer: TEST, agent: 'vet402' },
      { t: '2026-09-01T09:00:00Z', service: 'doctor', route: 'preflight', paid: true, usd: 5, network: 'base', payer: '0xold' },
    ]) },
  ];
  const s = summarizePayments(files, { known, fromIso: '2026-10-04T21:00:00Z', now });
  assert.deepEqual(s.totals.today.outside, { payments: 1, usd: 0.01, payers: 1 });
  assert.equal(s.totals.today.own.payments, 1);
  assert.equal(s.totals.d7.outside.payments, 2);
  assert.equal(s.totals.range.test.payments, 1);
  assert.equal(s.totals.range.outside.usd, 0.02, 'a payment before the range is left out');
  assert.equal(s.customers.length, 1);
  assert.deepEqual([s.customers[0].payer, s.customers[0].payments, s.customers[0].services.sort().join(',')], ['rCust', 2, 'ichimoku,presign']);
  assert.equal(s.recent[0].kind, 'own', 'newest first, ours labelled');
});

test('usage reader: summarizeAll keeps one cache per key and can start at a day; readText reads a repo file', async () => {
  const tree = { tree: [
    { type: 'blob', path: 'events/doctor/2026-11-01.jsonl', sha: 'a' },
    { type: 'blob', path: 'events/doctor/2026-11-03/10.jsonl', sha: 'b' },
  ] };
  const blobs = { a: '{"t":"2026-11-01T01:00:00Z","paid":true,"usd":1}\n', b: '{"t":"2026-11-03T10:00:00Z","paid":false}\n' };
  let blobReads = 0;
  const fetchFn = async (url) => {
    if (url.includes('/git/trees/')) return Response.json(tree);
    const m = /\/git\/blobs\/(\w+)/.exec(url);
    if (m) { blobReads++; return new Response(blobs[m[1]]); }
    if (url.endsWith('/contents/scripts/known.json')) return new Response('{"own_wallets":[]}');
    return new Response('', { status: 404 });
  };
  const reader = createUsageReader({ env: { USAGE_LOG_TOKEN: 't' }, fetchFn });
  const counts = await reader.summarizeAll((events) => events.length);
  const paid = await reader.summarizeAll((events) => events.filter((e) => e.paid).length, { key: 'paid', from: '2026-11-02' });
  assert.deepEqual(counts.files.map((f) => f.summary).sort(), [1, 1]);
  assert.deepEqual(paid.files.map((f) => [f.date, f.summary]), [['2026-11-03', 0]], 'only files from that day, with their own summary');
  const again = await reader.summarizeAll((events) => events.length);
  assert.deepEqual(again.files.map((f) => f.summary).sort(), [1, 1], 'the default key still has its own summaries');
  assert.equal(await reader.readText('scripts/known.json'), '{"own_wallets":[]}');
  assert.ok(blobReads >= 2);
});
