const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanWatch } = require('../lib/scan-watch');
const { createDispatcher } = require('../lib/delivery-dispatch');

const at = (iso) => Date.parse(iso);

test("scan watch: from 04:15 UTC, while Doctor serves an older scan; never before, never on today's, never without one", () => {
  const w = createScanWatch({ dispatcher: { enabled: true }, trustIndex: {} });
  const yesterday = '2026-10-20T00:45:24.547Z';
  assert.equal(w.missing(yesterday, at('2026-10-21T04:14:59Z')), false, 'the 03:17 run may still be running');
  assert.equal(w.missing(yesterday, at('2026-10-21T04:15:00Z')), true);
  assert.equal(w.missing(yesterday, at('2026-10-21T22:00:00Z')), true);
  assert.equal(w.missing('2026-10-21T03:44:10.000Z', at('2026-10-21T07:31:00Z')), false, "today's scan is served");
  assert.equal(w.missing(null, at('2026-10-21T07:31:00Z')), false, 'nothing loaded yet is not a reason to scan');
  assert.equal(w.missing('garbage', at('2026-10-21T07:31:00Z')), false);
});

test('scan watch: refreshes its copy first, starts the workflow once, then not again within two hours', async () => {
  let t = at('2026-10-21T04:30:00Z');
  let updated = '2026-10-20T00:45:24.547Z';
  let refreshed = 0;
  const trustIndex = { refresh: async () => { refreshed += 1; }, updated: () => updated };
  const starts = [];
  const dispatcher = { enabled: true, dispatch: async () => { starts.push(t); return true; } };
  const logs = [];
  const w = createScanWatch({ dispatcher, trustIndex, now: () => t, log: { log: (m) => logs.push(m) } });
  assert.equal(await w.tick(), true);
  assert.equal(refreshed, 1);
  assert.match(logs[0], /Doctor serves 2026-10-20T00:45:24\.547Z\); starting trust-scan\.yml/);
  t += 30 * 60 * 1000;
  assert.equal(await w.tick(), false, 'half an hour later: the run is still going');
  t += 90 * 60 * 1000;
  assert.equal(await w.tick(), true, 'two hours later and still missing: start again');
  updated = '2026-10-21T07:58:56.764Z';
  t += 2 * 60 * 60 * 1000;
  assert.equal(await w.tick(), false, "today's scan arrived");
  assert.equal(starts.length, 2);
  // A failed refresh keeps the copy Doctor has; without a token nothing is started.
  const failing = createScanWatch({ dispatcher, trustIndex: { refresh: async () => { throw new Error('GitHub down'); }, updated: () => '2026-10-19T00:00:00Z' }, now: () => t, log: { log() {} } });
  assert.equal(await failing.tick(), true);
  const off = createScanWatch({ dispatcher: { enabled: false, dispatch: async () => { throw new Error('should not be called'); } }, trustIndex, now: () => t });
  assert.equal(await off.tick(), false);
});

test('the dispatcher sends workflow inputs when it has them', async () => {
  const calls = [];
  const d = createDispatcher({ token: 'tok', workflow: 'trust-scan.yml', inputs: { only_if_missing: 'true' }, fetchImpl: async (url, opts) => { calls.push({ url, opts }); return new Response(null, { status: 204 }); } });
  assert.equal(await d.dispatch(), true);
  assert.equal(calls[0].url, 'https://api.github.com/repos/Fizzl13/x402-doctor/actions/workflows/trust-scan.yml/dispatches');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { ref: 'master', inputs: { only_if_missing: 'true' } });
});
