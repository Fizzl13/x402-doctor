// The badge owner's fleet (lib/concordium-agent.js ownerFleet): how many agents the owner account holds, read from
// Concordium's indexer; an info line from 50 agents, never a change to the verdict.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownerFleet, clearConcordiumCache, FLEET_MIN } = require('../lib/concordium-agent');
const { concordiumReasons } = require('../lib/preflight');

const OWNER = '3z9dkoTnLi2HEZvjnmKrMec2Gk2NKcEhdi4PugDWzP4GQtZiFa';
const reply = (body, status = 200) => async (url) => ({ ok: status === 200, status, url, text: async () => JSON.stringify(body) });

test('ownerFleet: the indexer total for the owner; null when unreadable or the rows are someone else\'s', async () => {
  clearConcordiumCache();
  let asked = null;
  const big = await ownerFleet(OWNER, 'mainnet', { fetchImpl: async (u) => { asked = u; return reply({ total: 1430, agents: [{ owner_account: OWNER }] })(u); } });
  assert.deepEqual(big, { agents: 1430, fleet: true });
  assert.match(asked, /\/agents\?network=mainnet&owner=3z9dko.*&limit=1$/);
  clearConcordiumCache();
  assert.deepEqual(await ownerFleet(OWNER, 'mainnet', { fetchImpl: reply({ total: 1, agents: [{ owner_account: OWNER }] }) }), { agents: 1, fleet: false });
  clearConcordiumCache();
  assert.equal(await ownerFleet(OWNER, 'mainnet', { fetchImpl: reply({ total: 5436, agents: [{ owner_account: 'someoneElse' }] }) }), null, 'an indexer that ignores the filter is not believed');
  clearConcordiumCache();
  assert.equal(await ownerFleet(OWNER, 'mainnet', { fetchImpl: reply({}, 503) }), null);
  clearConcordiumCache();
  assert.equal(await ownerFleet(OWNER, 'mainnet', { fetchImpl: async () => { throw new Error('down'); } }), null);
  assert.equal(await ownerFleet(null, 'mainnet'), null);
});

test('ownerFleet is cached an hour per owner', async () => {
  clearConcordiumCache();
  let calls = 0;
  let t = 0;
  const f = async (u) => { calls += 1; return reply({ total: 600, agents: [{ owner_account: OWNER }] })(u); };
  await ownerFleet(OWNER, 'mainnet', { fetchImpl: f, now: () => t });
  t += 59 * 60 * 1000;
  await ownerFleet(OWNER, 'mainnet', { fetchImpl: f, now: () => t });
  assert.equal(calls, 1);
  t += 2 * 60 * 1000;
  await ownerFleet(OWNER, 'mainnet', { fetchImpl: f, now: () => t });
  assert.equal(calls, 2);
});

test('preflight: an info line for a fleet owner, next to Verified by Concordium; nothing below the threshold', () => {
  const agent = { tokenAddress: 'Mf22oVsbu3vf4Jb1cga49', tokenId: 5120, network: 'mainnet' };
  const results = [{ network: 'eip155:8453', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', outcome: 'verified-external-key' }];
  const fleet = concordiumReasons({ agent: { ...agent, ownerAgents: 1430 }, results });
  assert.deepEqual(fleet.map((r) => [r.level, r.code]), [['info', 'concordium_owner_fleet'], ['info', 'concordium_verified']]);
  assert.match(fleet[0].message, /holds 1430 agents/);
  const single = concordiumReasons({ agent: { ...agent, ownerAgents: 1 }, results });
  assert.deepEqual(single.map((r) => r.code), ['concordium_verified']);
  assert.equal(FLEET_MIN, 50);
});
