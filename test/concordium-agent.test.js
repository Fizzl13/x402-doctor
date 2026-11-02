'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { privateKeyToAccount } = require('viem/accounts');
const { verifyConcordiumPayees, badgeNetwork, cardBadge, registryCall, sha256Hex, clearConcordiumCache } = require('../lib/concordium-agent');
const { checkConcordiumAgent } = require('../lib/diagnose');

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const OWNER = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB';
const WALLET = '4Ft9oKbZ4pYCSgWjNiwr1Q2ypCzD9ZDyxfi3oUqE2ZTNQtXwrb';
const SELLER = 'https://seller.example';
const CARD_URL = `${SELLER}/.well-known/agent-card.json`;

// A CIS-2 token address as the registry writes it: Base58Check of 2, LEB128 index, LEB128 subindex, token id.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function tokenAddress(index, tokenId = 0) {
  const leb = [];
  let n = index;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; leb.push(b); } while (n);
  const id = Buffer.alloc(8); id.writeBigUInt64LE(BigInt(tokenId));
  const payload = Buffer.from([2, ...leb, 0, ...id]);
  const check = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  let x = BigInt(`0x${Buffer.concat([payload, check]).toString('hex')}`);
  let s = '';
  while (x > 0n) { s = ALPHABET[Number(x % 58n)] + s; x /= 58n; }
  return s;
}
const BADGE = 'JyP9TtQC3HCNrTYR3sc2T'; // testnet registry <12802,0>, token 0 (a real badge)

const card = (extra = {}) => JSON.stringify({
  name: 'Seller',
  url: SELLER,
  capabilities: { extensions: [{ uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1', params: { tokenAddress: `${TESTNET}/cis-2:${BADGE}`, agentWallet: `${TESTNET}:${WALLET}` } }] },
  ...extra,
});

// The registry service as seen by fetch: one JSON-RPC tool call per request, answered from `tools`.
function registry(tools, { sse = false } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { params } = JSON.parse(init.body);
    calls.push(params);
    const value = typeof tools[params.name] === 'function' ? tools[params.name](params.arguments) : tools[params.name];
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] } });
    return { ok: true, status: 200, text: async () => (sse ? `event: message\ndata: ${body}\n\n` : body) };
  };
  return { fetchImpl, calls };
}
const pages = (map) => async (url) => (url in map ? { status: 200, text: map[url] } : { status: 404, text: 'not found' });
const agent = (text, extra = {}) => ({ token_id: '0', owner_account: OWNER, agent_uri: CARD_URL, metadata_hash_hex: sha256Hex(text), agent_wallet: WALLET, status: 'Active', ...extra });

test.beforeEach(() => clearConcordiumCache());

test('badgeNetwork: the token address names its registry contract (10082 mainnet, 12802 testnet, else none)', () => {
  assert.equal(badgeNetwork(BADGE), 'testnet');
  assert.equal(badgeNetwork(tokenAddress(12802)), 'testnet');
  assert.equal(badgeNetwork(tokenAddress(10082, 7)), 'mainnet');
  assert.equal(badgeNetwork(tokenAddress(999)), null);
  assert.equal(badgeNetwork('not-base58-0OIl'), null);
});

test('cardBadge: reads the A2A extension (CAIP-19 or short form) and the legacy concordium block', () => {
  assert.deepEqual(cardBadge(JSON.parse(card())), { tokenAddress: BADGE, chain: TESTNET });
  assert.deepEqual(cardBadge({ capabilities: { extensions: [{ uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1', params: { tokenAddress: BADGE } }] } }), { tokenAddress: BADGE, chain: null });
  assert.deepEqual(cardBadge({ concordium: { token_address: BADGE, chain: MAINNET } }), { tokenAddress: BADGE, chain: MAINNET });
  assert.equal(cardBadge({ capabilities: { extensions: [{ uri: 'https://example.com/other', params: { tokenAddress: BADGE } }] } }), null);
  assert.equal(cardBadge(null), null);
});

test('registryCall: reads a JSON or an SSE answer, and caches it', async () => {
  const r = registry({ agent_by_token_address: { status: 'Active' } }, { sse: true });
  assert.deepEqual(await registryCall('agent_by_token_address', { token_address: BADGE, network: 'testnet' }, { fetchImpl: r.fetchImpl }), { status: 'Active' });
  await registryCall('agent_by_token_address', { token_address: BADGE, network: 'testnet' }, { fetchImpl: r.fetchImpl });
  assert.equal(r.calls.length, 1);
});

test('verified-wallet: the Concordium payTo is the agent wallet of an active badge whose card hashes to the chain', async () => {
  const text = card();
  const r = registry({ agent_by_token_address: (a) => (a.token_address === BADGE && a.network === 'testnet' ? agent(text) : null) });
  const out = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }, { network: TESTNET, payTo: `${TESTNET}:${WALLET}` }], { url: `${SELLER}/paid`, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: r.fetchImpl });
  assert.deepEqual(out.results.map((x) => x.outcome), ['verified-wallet', 'verified-wallet']);
  assert.equal(out.agent.network, 'testnet');
  assert.equal(out.agent.owner, OWNER);
  assert.equal(out.agent.anchoredCard, undefined);
});

test('owner-only, no-agent-wallet and mismatch on Concordium payTos', async () => {
  const text = card();
  const noWallet = registry({ agent_by_token_address: agent(text, { agent_wallet: null }) });
  const a = await verifyConcordiumPayees([{ network: TESTNET, payTo: OWNER }, { network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: noWallet.fetchImpl });
  assert.deepEqual(a.results.map((x) => x.outcome), ['owner-only', 'no-agent-wallet']);
  clearConcordiumCache();
  const withWallet = registry({ agent_by_token_address: agent(text) });
  const b = await verifyConcordiumPayees([{ network: TESTNET, payTo: OWNER }], { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: withWallet.fetchImpl });
  assert.deepEqual(b.results.map((x) => x.outcome), ['mismatch']);
});

test('card-mismatch: the card served at agent_uri is not the one whose hash is on chain', async () => {
  const r = registry({ agent_by_token_address: agent(card({ name: 'Old card' })) });
  const out = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({ [CARD_URL]: card() }), fetchImpl: r.fetchImpl });
  assert.equal(out.results[0].outcome, 'card-mismatch');
});

test('endpoint-unlisted: a copy of the card on another server shows the same badge, but the anchored card does not list it', async () => {
  const text = card();
  const r = registry({ agent_by_token_address: agent(text) });
  const out = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: 'https://copycat.example/paid', safeFetch: pages({ [CARD_URL]: text, 'https://copycat.example/.well-known/agent-card.json': text }), fetchImpl: r.fetchImpl });
  assert.equal(out.results[0].outcome, 'endpoint-unlisted');
  // Listed in the anchored card (an A2A interface on another host): the endpoint is the agent's.
  clearConcordiumCache();
  const listed = card({ supportedInterfaces: [{ url: 'https://api.seller.example/a2a', protocolBinding: 'JSONRPC' }] });
  const r2 = registry({ agent_by_token_address: agent(listed) });
  const ok = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: 'https://api.seller.example/paid', safeFetch: pages({ [CARD_URL]: listed, 'https://api.seller.example/.well-known/agent-card.json': listed }), fetchImpl: r2.fetchImpl });
  assert.equal(ok.results[0].outcome, 'verified-wallet');
});

test('revoked, unknown badge, foreign contract and an unreadable registry', async () => {
  const text = card();
  const revoked = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({ agent_by_token_address: agent(text, { status: 'Revoked' }) }).fetchImpl });
  assert.equal(revoked.results[0].outcome, 'revoked');
  clearConcordiumCache();
  const missing = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({}).fetchImpl });
  assert.equal(missing.results[0].outcome, 'not-read');
  const foreignCard = JSON.stringify({ url: SELLER, capabilities: { extensions: [{ uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1', params: { tokenAddress: tokenAddress(999) } }] } });
  const foreign = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({ [CARD_URL]: foreignCard }), fetchImpl: registry({}).fetchImpl });
  assert.match(foreign.results[0].reason, /not a token of the official/);
  // A card that claims mainnet for a testnet badge.
  const wrongChain = card().replace(`${TESTNET}/cis-2:`, `${MAINNET}/cis-2:`);
  const lie = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({ [CARD_URL]: wrongChain }), fetchImpl: registry({}).fetchImpl });
  assert.equal(lie.results[0].outcome, 'not-read');
  clearConcordiumCache();
  const down = await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) });
  assert.match(down.results[0].reason, /registry HTTP 503/);
});

test('verified-external-key: an EVM payTo is the address of the secp256k1 key bound with CIS-8 and still held by the owner', async () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const key = { namespace: 'eip155', key_type: 'secp256k1-uncompressed', public_key_hex: account.publicKey.slice(2) };
  const text = card();
  const tools = (holder) => ({ agent_by_token_address: agent(text, { external_reference: { contract_address: { index: 12801, subindex: 0 }, kind: 'Cis8', key } }), owner_of_key: holder });
  const accepts = [{ network: 'eip155:8453', payTo: account.address }, { network: 'eip155:8453', payTo: '0x000000000000000000000000000000000000dEaD' }];
  const bound = await verifyConcordiumPayees(accepts, { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry(tools({ owner_account: OWNER })).fetchImpl });
  assert.deepEqual(bound.results.map((x) => x.outcome), ['verified-external-key', 'mismatch']);
  clearConcordiumCache();
  const unbound = await verifyConcordiumPayees(accepts.slice(0, 1), { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry(tools(null)).fetchImpl });
  assert.equal(unbound.results[0].outcome, 'not-bound');
  clearConcordiumCache();
  const someoneElse = await verifyConcordiumPayees(accepts.slice(0, 1), { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry(tools({ owner_account: WALLET })).fetchImpl });
  assert.equal(someoneElse.results[0].outcome, 'not-bound');
  clearConcordiumCache();
  const revoked = await verifyConcordiumPayees(accepts.slice(0, 1), { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry(tools({ owner: OWNER, status: 'Revoked' })).fetchImpl });
  assert.equal(revoked.results[0].outcome, 'not-bound', 'a revoked CIS-8 binding binds nothing');
  clearConcordiumCache();
  const asOwner = await verifyConcordiumPayees(accepts.slice(0, 1), { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry(tools({ owner: OWNER, status: 'Active' })).fetchImpl });
  assert.equal(asOwner.results[0].outcome, 'verified-external-key', "the registry's own field name (owner)");
  clearConcordiumCache();
  const noKey = await verifyConcordiumPayees(accepts.slice(0, 1), { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({ agent_by_token_address: agent(text) }).fetchImpl });
  assert.equal(noKey.results[0].outcome, 'not-bound');
});

test('no card or no badge: nothing to report', async () => {
  assert.deepEqual(await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({}), fetchImpl: registry({}).fetchImpl }), { agent: null, results: [] });
  const plain = JSON.stringify({ name: 'No badge', url: SELLER });
  assert.deepEqual(await verifyConcordiumPayees([{ network: TESTNET, payTo: WALLET }], { url: SELLER, safeFetch: pages({ [CARD_URL]: plain }), fetchImpl: registry({}).fetchImpl }), { agent: null, results: [] });
});

test('checkConcordiumAgent: a pass with the agent, a warn with a fix, and no check without a badge', async () => {
  const text = card();
  const checks = [];
  await checkConcordiumAgent([{ network: TESTNET, payTo: WALLET }], `${SELLER}/paid`, checks, { safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({ agent_by_token_address: agent(text) }).fetchImpl });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, 'concordium-agent');
  assert.equal(checks[0].status, 'pass');
  assert.match(checks[0].message, /Verified by Concordium.*agent #0 in the Concordium Agent Registry on testnet/);
  clearConcordiumCache();
  const warn = [];
  await checkConcordiumAgent([{ network: TESTNET, payTo: WALLET }], `${SELLER}/paid`, warn, { safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({ agent_by_token_address: agent(card({ name: 'Old' })) }).fetchImpl });
  assert.equal(warn[0].status, 'warn');
  assert.match(warn[0].hint, /sha256sum.*check-badge\/JyP9TtQC3HCNrTYR3sc2T/);
  const none = [];
  await checkConcordiumAgent([{ network: TESTNET, payTo: WALLET }], `${SELLER}/paid`, none, { safeFetch: pages({}), fetchImpl: registry({}).fetchImpl });
  assert.equal(none.length, 0);
});

test("x402 Doctor's own Agent Card: served byte for byte, with the badge of agent #993 on testnet and this origin listed", async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { cardOrigins } = require('../lib/concordium-agent');
  const { createApp } = require('../server');
  const file = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-card.json'));
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const app = createApp({ allowPrivate: true, env: {}, trustIndex });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/.well-known/agent-card.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(sha256Hex(body.toString('utf8')), crypto.createHash('sha256').update(file).digest('hex'), 'the served bytes are the file: its hash is pinned on chain');
    const card = JSON.parse(body);
    assert.deepEqual(cardBadge(card), { tokenAddress: 'JyP9Y8gHmf4U8QPMm1TkT', chain: TESTNET });
    assert.equal(badgeNetwork('JyP9Y8gHmf4U8QPMm1TkT'), 'testnet');
    assert.ok(cardOrigins(card).has('https://x402-doctor.fizzl.eu'));
  } finally { server.close(); }
});

test('the CIS-8004 module schema served for the pin page is the registry module schema', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = Buffer.from(fs.readFileSync(path.join(__dirname, '..', 'public', 'concordium', 'cis8004-schema.b64'), 'utf8').trim(), 'base64');
  assert.equal(schema.subarray(0, 2).toString('hex'), 'ffff', 'a versioned module schema');
  assert.ok(schema.includes(Buffer.from('CIS-8004')) && schema.includes(Buffer.from('setAgentURI')));
});
