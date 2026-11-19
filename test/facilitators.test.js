'use strict';

// lib/facilitators.js: the live facilitator status, with a fake fetch (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFacilitatorStatus, readSupported, FACILITATORS } = require('../lib/facilitators');
const { createApp } = require('../server.js');

const FACS = [
  { id: 'a', name: 'A', url: 'https://a.example' },
  { id: 'b', name: 'B', url: 'https://b.example' },
  { id: 'c', name: 'C', url: 'https://c.example' },
  { id: 'k', name: 'K', url: 'https://k.example', keyRequired: true },
];

function fakeFetch(answers) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const a = answers[new URL(url).host];
    if (a === 'throw') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('readSupported: v1 names become CAIP-2, testnets marked, schemes and versions collected', () => {
  const r = readSupported({ kinds: [
    { x402Version: 1, scheme: 'exact', network: 'base' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
    { x402Version: 2, scheme: 'upto', network: 'eip155:8453' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
    { bad: true },
  ] });
  assert.equal(r.kinds, 4);
  assert.deepEqual(r.networks.map((n) => [n.id, n.testnet]), [['eip155:8453', false], ['eip155:84532', true]]);
  assert.deepEqual(r.networks[0].schemes, ['exact', 'upto']);
  assert.equal(r.networks[0].name, 'Base');
  assert.deepEqual(r.x402_versions, [1, 2]);
  assert.deepEqual(readSupported(null).networks, []);
});

test('snapshot: up, down (HTTP error, no kinds, unreachable), key-only not checked; cached for 5 minutes; network filter', async () => {
  let t = 1_000_000;
  const { calls, fetchImpl } = fakeFetch({
    'a.example': { body: { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 2, scheme: 'exact', network: 'eip155:196' }] } },
    'b.example': { status: 503, body: { error: 'down' } },
    'c.example': 'throw',
  });
  const board = createFacilitatorStatus({ fetchImpl, now: () => t, facilitators: FACS });
  const s = await board.snapshot();
  assert.deepEqual(s.facilitators.map((f) => [f.id, f.state]), [['a', 'up'], ['b', 'down'], ['c', 'down'], ['k', 'not_checked']]);
  assert.equal(s.up, 1);
  assert.equal(s.down, 2);
  assert.match(s.facilitators[1].note, /HTTP 503/);
  assert.match(s.facilitators[2].note, /Not reachable/);
  assert.equal(calls.length, 3, 'the key-only facilitator is never called');
  assert.ok(calls.every((u) => u.endsWith('/supported')));
  await board.snapshot();
  assert.equal(calls.length, 3, 'cached');
  const x = await board.snapshot({ network: 'eip155:196' });
  assert.deepEqual(x.network.facilitators_up, ['a']);
  assert.equal(x.facilitators[0].id, 'a', 'the ones that settle it come first');
  const none = await board.snapshot({ network: 'solana' });
  assert.equal(none.network.id, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.deepEqual(none.network.facilitators_up, []);
  t += 5 * 60 * 1000 + 1;
  const again = await board.snapshot();
  assert.equal(calls.length, 6, 'checked again after 5 minutes');
  assert.deepEqual(again.facilitators[0].recent && [again.facilitators[0].recent.checks, again.facilitators[0].recent.up], [2, 2]);
  assert.equal(again.facilitators[1].last_up, null);
});

test('GET /api/v1/facilitators and /facilitators', async (t) => {
  const facilitatorStatus = { snapshot: async ({ network }) => ({ up: 1, down: 0, facilitators: [], ...(network && { network: { id: network, facilitators_up: [] } }) }) };
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) }, facilitatorStatus });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/facilitators?network=eip155:8453`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await res.json()).network.id, 'eip155:8453');
  assert.equal((await fetch(`${base}/api/v1/facilitators?network=${encodeURIComponent('<script>')}`)).status, 400);
  const page = await (await fetch(`${base}/facilitators`)).text();
  assert.match(page, /<title>x402 facilitator status/);
  assert.match(page, /\/api\/v1\/facilitators/);
});


test('NEAR: the v1 names map to near:mainnet / near:testnet, and the board lists the public NEAR facilitators', () => {
  const s = readSupported({ kinds: [{ x402Version: 1, scheme: 'exact', network: 'near' }, { x402Version: 2, scheme: 'exact', network: 'near:mainnet' }, { x402Version: 1, scheme: 'exact', network: 'near-testnet' }] });
  assert.deepEqual(s.networks.map((n) => [n.id, n.name, n.testnet]), [['near:mainnet', 'NEAR', false], ['near:testnet', 'NEAR testnet', true]]);
  const ids = FACILITATORS.map((f) => f.id);
  for (const id of ['fizzl', 'ultravioleta', 'fastnear']) assert.ok(ids.includes(id), id);
});
