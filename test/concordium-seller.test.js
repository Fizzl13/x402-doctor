'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sha256Hex, clearConcordiumCache } = require('../lib/concordium-agent');
const { concordiumSeller, cleanAccepts } = require('../lib/concordium-seller');
const { createApp } = require('../server.js');

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const OWNER = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB';
const WALLET = '4Ft9oKbZ4pYCSgWjNiwr1Q2ypCzD9ZDyxfi3oUqE2ZTNQtXwrb';
const SELLER = 'https://seller.example';
const CARD_URL = `${SELLER}/.well-known/agent-card.json`;
const BADGE = 'JyP9TtQC3HCNrTYR3sc2T'; // testnet registry <12802,0>, token 0

const card = (extra = {}) => JSON.stringify({
  name: 'Seller',
  url: SELLER,
  capabilities: { extensions: [{ uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1', params: { tokenAddress: `${TESTNET}/cis-2:${BADGE}`, agentWallet: `${TESTNET}:${WALLET}` } }] },
  ...extra,
});
const registry = (tools) => async (_url, init) => {
  const { params } = JSON.parse(init.body);
  const value = typeof tools[params.name] === 'function' ? tools[params.name](params.arguments) : tools[params.name];
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] } }) };
};
const pages = (map) => async (url) => (url in map ? { status: 200, text: map[url] } : { status: 404, text: 'not found' });
const agent = (text, extra = {}) => ({ token_id: '0', owner_account: OWNER, agent_uri: CARD_URL, metadata_hash_hex: sha256Hex(text), agent_wallet: WALLET, status: 'Active', ...extra });

test.beforeEach(() => clearConcordiumCache());

test('concordiumSeller: verified, a problem (the payTo the wallet would pay isn\'t the agent\'s), or no badge at all', async () => {
  const text = card();
  const ok = await concordiumSeller(`${SELLER}/paid`, { accepts: [{ network: TESTNET, payTo: WALLET }], safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({ agent_by_token_address: agent(text) }) });
  assert.equal(ok.badge.verdict, 'verified');
  assert.equal(ok.badge.agent.network, 'testnet');
  assert.equal(ok.badge.agent.owner, OWNER);
  assert.deepEqual(ok.badge.payees, [{ network: TESTNET, payTo: WALLET, outcome: 'verified-wallet' }]);
  assert.match(ok.badge.summary, /^Verified by Concordium/);
  assert.equal(ok.proof, null);
  clearConcordiumCache();
  const bad = await concordiumSeller(`${SELLER}/paid`, { accepts: [{ network: TESTNET, payTo: OWNER }], safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({ agent_by_token_address: agent(text) }) });
  assert.equal(bad.badge.verdict, 'problem');
  assert.equal(bad.badge.payees[0].outcome, 'mismatch');
  assert.ok(bad.badge.fix);
  clearConcordiumCache();
  const none = await concordiumSeller(`${SELLER}/paid`, { accepts: [{ network: 'eip155:8453', payTo: '0x1111111111111111111111111111111111111111' }], safeFetch: pages({}), fetchImpl: registry({}) });
  assert.deepEqual(none, { url: `${SELLER}/paid`, badge: null, proof: null });
});

test('concordiumSeller without accepts: a seller without a badge costs one read of its card, and no 402 is asked', async () => {
  const asked = [];
  const safeFetch = async (url) => { asked.push(url); return { status: 404, text: 'not found' }; };
  assert.deepEqual(await concordiumSeller(`${SELLER}/paid`, { safeFetch, fetchImpl: registry({}) }), { url: `${SELLER}/paid`, badge: null, proof: null });
  assert.deepEqual(asked, [CARD_URL]);
  asked.length = 0;
  const plain = async (url) => { asked.push(url); return { status: 200, text: JSON.stringify({ name: 'No badge' }) }; };
  assert.equal((await concordiumSeller(`${SELLER}/paid`, { safeFetch: plain, fetchImpl: registry({}) })).badge, null);
  assert.deepEqual(asked, [CARD_URL]);
});

test('cleanAccepts: at most ten { network, payTo, asset? } with short strings', () => {
  assert.equal(cleanAccepts(undefined), null);
  assert.deepEqual(cleanAccepts([{ network: 'eip155:8453', payTo: '0xabc', asset: '0xdef', extra: 1 }]), [{ network: 'eip155:8453', payTo: '0xabc', asset: '0xdef' }]);
  for (const bad of [[], 'x', [{ network: 'eip155:8453' }], [{ network: 1, payTo: 'a' }], Array(11).fill({ network: 'a', payTo: 'b' }), [{ network: 'a', payTo: 'b'.repeat(201) }]]) {
    assert.throws(() => cleanAccepts(bad), (err) => err.status === 400, JSON.stringify(bad).slice(0, 60));
  }
});

test('POST /api/v1/concordium/seller: a bad url or bad accepts is 400 before anything is fetched', async () => {
  const app = createApp({ env: {}, status: { snapshot: async () => ({}) } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/v1/concordium/seller`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ url: 'ftp://seller.example/x' })).status, 400);
    assert.equal((await post({ url: 'https://' })).status, 400);
    const r = await post({ url: 'https://seller.example/paid', accepts: [{ network: 'eip155:8453' }] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /network and payTo/);
  } finally { server.close(); }
});
