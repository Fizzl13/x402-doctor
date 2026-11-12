'use strict';
// Lock destinations (lib/concordium-destinations.js): the payout addresses Concordium vouches for, per network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { concordiumDestinations, cleanSellers } = require('../lib/concordium-destinations');
const { createApp } = require('../server.js');

const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const WALLET = '45R4vB9JnXDUkYVNBrQE8yyg6o2qH32g7fX5N7i9yWxHxnFP7J';
const KEY = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const agent = { network: 'mainnet', tokenId: '5120', tokenAddress: null, owner: WALLET, agentWallet: WALLET };

// What lib/concordium-seller.js answers per seller, as the check stub returns it.
const views = {
  'https://verified.example/paid': { badge: { verdict: 'verified', summary: 'Verified by Concordium', agent, payees: [{ network: MAINNET, payTo: WALLET, outcome: 'verified-wallet' }, { network: 'eip155:8453', payTo: KEY, outcome: 'verified-external-key' }] } },
  'https://twice.example/paid': { badge: { verdict: 'verified', summary: 'Verified by Concordium', agent, payees: [{ network: MAINNET, payTo: WALLET, outcome: 'verified-wallet' }] } },
  'https://revoked.example/paid': { badge: { verdict: 'problem', summary: 'The agent is revoked in the registry: do not pay on its badge.', agent, payees: [{ network: MAINNET, payTo: WALLET, outcome: 'verified-wallet' }] } },
  'https://partial.example/paid': { badge: { verdict: 'partial', summary: 'One payTo could not be compared', agent, payees: [{ network: MAINNET, payTo: WALLET, outcome: 'verified-wallet' }, { network: 'eip155:8453', payTo: '0x1111111111111111111111111111111111111111', outcome: 'not-bound' }] } },
  'https://nobadge.example/paid': { badge: null, proof: null },
};
const check = async (url) => {
  if (url === 'https://down.example/paid') throw new Error('the seller did not answer');
  return views[url];
};

test('concordiumDestinations: only vouched payTos make the list, once each; everything else is refused with why', async () => {
  const out = await concordiumDestinations(['https://verified.example/paid', 'https://twice.example/paid', 'https://revoked.example/paid', 'https://partial.example/paid', 'https://nobadge.example/paid', 'https://down.example/paid', 'https://verified.example/paid'], { check, now: () => Date.parse('2026-11-12T12:00:00Z') });
  assert.equal(out.checked_at, '2026-11-12T12:00:00.000Z');
  assert.deepEqual(out.destinations.map((d) => [d.network, d.payTo, d.seller]), [
    [MAINNET, WALLET, 'https://verified.example/paid'],
    ['eip155:8453', KEY, 'https://verified.example/paid'],
  ], 'the same payTo of a second seller is not listed twice');
  assert.match(out.destinations[0].how, /agent's own wallet/);
  assert.match(out.destinations[1].how, /CIS-8/);
  assert.equal(out.destinations[0].agent.tokenId, '5120');
  assert.deepEqual(out.allowlist, { [MAINNET]: [WALLET], 'eip155:8453': [KEY] });
  const why = Object.fromEntries(out.refused.map((r) => [`${r.seller} ${r.payTo || ''}`.trim(), r.reason]));
  assert.match(why['https://revoked.example/paid'], /revoked/, 'a badge with a problem keeps every payTo of that seller off, even a matching one');
  assert.match(why['https://partial.example/paid 0x1111111111111111111111111111111111111111'], /not vouched for \(not-bound\)/);
  assert.match(why['https://nobadge.example/paid'], /no Verified by Concordium badge/);
  assert.match(why['https://down.example/paid'], /could not be checked: the seller did not answer/);
  assert.match(out.note, /Protocol-Level Locks/);
});

test('cleanSellers: 1 to 10 http(s) URLs, duplicates dropped', () => {
  assert.throws(() => cleanSellers(undefined), /1 to 10/);
  assert.throws(() => cleanSellers([]), /1 to 10/);
  assert.throws(() => cleanSellers(Array.from({ length: 11 }, (_, i) => `https://s${i}.example/`)), /1 to 10/);
  assert.throws(() => cleanSellers(['ftp://seller.example/']), /http or https/);
  assert.throws(() => cleanSellers(['https://']), /not a valid URL/);
  assert.deepEqual(cleanSellers(['https://a.example/x', 'https://a.example/x', 'https://b.example/y']), ['https://a.example/x', 'https://b.example/y']);
});

test('POST /api/v1/concordium/destinations: bad input is 400 before anything is fetched; a seller without a badge is refused', async () => {
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/v1/concordium/destinations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ urls: 'https://a.example' })).status, 400);
    const bad = await post({ urls: ['ftp://seller.example/x'] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /http or https/);
    // A local address is never fetched (safeFetch refuses it): refused, not an error.
    const local = await post({ urls: ['http://127.0.0.1:9/paid'] });
    assert.equal(local.status, 200);
    const body = await local.json();
    assert.deepEqual(body.destinations, []);
    assert.equal(body.refused.length, 1);
    assert.deepEqual(body.allowlist, {});
  } finally { server.close(); }
});
