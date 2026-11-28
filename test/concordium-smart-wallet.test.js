'use strict';
// Verified by Concordium for a smart wallet (a Safe) the bound key owns: Concordium's documented two-leg pattern, as
// XDC AI runs it. CIS-8 binds the key; the anchored card names the wallet; its owners and threshold are read live.
const test = require('node:test');
const assert = require('node:assert/strict');
const { privateKeyToAccount } = require('viem/accounts');
const { verifyConcordiumPayees, lookupBadge, cardSmartWallet, sha256Hex, clearConcordiumCache, externalKeyAddress } = require('../lib/concordium-agent');
const { checkConcordiumAgent } = require('../lib/diagnose');

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const OWNER = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB';
const SELLER = 'https://seller.example';
const CARD_URL = `${SELLER}/.well-known/agent-card.json`;
const BADGE = 'JyP9TtQC3HCNrTYR3sc2T'; // testnet registry <12802,0>, token 0
const XDC = 'eip155:50';
const SAFE = '0x7ae1ef2979b0de85d7dea7f6a5582417d4a98c55';
const OTHER1 = '0xeb2004691ccbec641465bd676709e6ac47bea461';
const OTHER2 = '0xc6a76fac1d05f49b12c4b563cccf6812a4bbd3e0';

// A compressed secp256k1 key, as XDC AI binds it with CIS-8.
const account = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const full = account.publicKey.slice(4);
const compressed = `${parseInt(full.slice(-2), 16) % 2 ? '03' : '02'}${full.slice(0, 64)}`;
const key = { namespace: XDC, key_type: 'secp256k1-compressed', public_key_hex: compressed };
const KEY_ADDR = account.address.toLowerCase();

const card = ({ ownerCount = 1, threshold = 1, claim = 'sole-controller', publicKey = compressed, address = `${XDC}:${SAFE}` } = {}) => JSON.stringify({
  name: 'Seller',
  url: SELLER,
  capabilities: {
    extensions: [
      { uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1', params: { tokenAddress: `${TESTNET}/cis-2:${BADGE}` } },
      { uri: 'https://concordium.com/a2a-extensions/xdc-wallet-binding/v1', params: { bindingSpec: 'xdc-wallet-binding/v1', claim, ownerKey: { keyType: 'secp256k1-compressed', namespace: XDC, publicKey }, wallet: { address, ownerCount, threshold } } },
    ],
  },
});
function registry(tools) {
  const fetchImpl = async (_url, init) => {
    const { params } = JSON.parse(init.body);
    const value = tools[params.name];
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] } });
    return { ok: true, status: 200, text: async () => body };
  };
  return fetchImpl;
}
const pages = (map) => async (url) => (url in map ? { status: 200, text: map[url] } : { status: 404, text: 'not found' });
const agentRecord = (text, extra = {}) => ({ token_id: '0', owner_account: OWNER, agent_uri: CARD_URL, metadata_hash_hex: sha256Hex(text), agent_wallet: null, status: 'Active', external_reference: { contract_address: { index: 12801, subindex: 0 }, kind: 'Cis8', key }, ...extra });
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
// The chain as eth_call sees it: getOwners() and getThreshold() of one Safe.
function chain({ owners = [KEY_ADDR], threshold = 1, fail = null } = {}) {
  const calls = [];
  const evmCall = async (network, to, data) => {
    calls.push({ network, to, data });
    if (fail) throw new Error(fail);
    if (to !== SAFE) return '0x';
    if (data === '0xa0e67e2b') return `0x${word('20')}${word(owners.length.toString(16))}${owners.map(word).join('')}`;
    if (data === '0xe75235b8') return `0x${word(threshold.toString(16))}`;
    return '0x';
  };
  return { evmCall, calls };
}
const run = (text, accepts, evm, tools = {}) => {
  clearConcordiumCache();
  return verifyConcordiumPayees(accepts, { url: SELLER, safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({ agent_by_token_address: agentRecord(text), owner_of_key: { owner_account: OWNER, status: 'Active' }, ...tools }), evmCall: evm.evmCall });
};

test('the card names the Safe for the bound key; another key or a non-eip155 address is not taken', () => {
  assert.equal(externalKeyAddress(key), KEY_ADDR);
  assert.deepEqual(cardSmartWallet(JSON.parse(card()), key), { network: XDC, address: SAFE, claim: 'sole-controller', ownerCount: 1, threshold: 1, extension: 'https://concordium.com/a2a-extensions/xdc-wallet-binding/v1' });
  assert.equal(cardSmartWallet(JSON.parse(card({ publicKey: `02${'ab'.repeat(32)}` })), key), null, 'a wallet named for another key');
  assert.equal(cardSmartWallet(JSON.parse(card({ address: SAFE })), key), null, 'no chain in the address');
});

test('verified-safe-owner: payTo is the Safe the anchored card names, and the bound key solely controls it (read live)', async () => {
  const evm = chain();
  const out = await run(card(), [{ network: XDC, payTo: '0x7aE1ef2979b0dE85d7Dea7F6A5582417D4a98c55' }, { network: XDC, payTo: account.address }, { network: 'eip155:8453', payTo: SAFE }], evm);
  assert.deepEqual(out.results.map((r) => r.outcome), ['verified-safe-owner', 'verified-external-key', 'mismatch'], 'the same address on another chain is not that Safe');
  assert.match(out.results[0].reason, /solely controls/);
  assert.equal(out.results[0].wallet.sole_controller, true);
  assert.equal(out.results[0].wallet.matches_card, true);
  assert.deepEqual(evm.calls.map((c) => c.network), [XDC, XDC], 'one live read of the wallet, on its own chain');
});

test('one of several owners: verified, and said as such', async () => {
  const out = await run(card({ claim: 'one-of-n-owner', ownerCount: 3, threshold: 2 }), [{ network: XDC, payTo: SAFE }], chain({ owners: [OTHER1, OTHER2, KEY_ADDR], threshold: 2 }));
  assert.equal(out.results[0].outcome, 'verified-safe-owner');
  assert.match(out.results[0].reason, /3 owners, the bound key one of them, 2 needed to sign/);
  assert.equal(out.results[0].wallet.sole_controller, false);
});

test('the key no longer an owner, or the wallet not what the card says: mismatch', async () => {
  const gone = await run(card(), [{ network: XDC, payTo: SAFE }], chain({ owners: [OTHER1] }));
  assert.equal(gone.results[0].outcome, 'mismatch');
  assert.match(gone.results[0].reason, /not one of its owners now/);
  const added = await run(card(), [{ network: XDC, payTo: SAFE }], chain({ owners: [KEY_ADDR, OTHER1], threshold: 1 }));
  assert.equal(added.results[0].outcome, 'mismatch', 'the card says sole controller; the chain says otherwise');
  assert.match(added.results[0].reason, /card says 1 owner\(s\) and threshold 1; the wallet now has 2 and 1/);
});

test('a chain that cannot be read, a contract that is not a Safe, a key no longer bound', async () => {
  const down = await run(card(), [{ network: XDC, payTo: SAFE }], chain({ fail: 'RPC HTTP 503' }));
  assert.equal(down.results[0].outcome, 'not-read');
  assert.match(down.results[0].reason, /RPC HTTP 503/);
  const notSafe = await run(card({ address: `${XDC}:${OTHER1}` }), [{ network: XDC, payTo: OTHER1 }], chain());
  assert.equal(notSafe.results[0].outcome, 'not-read');
  assert.match(notSafe.results[0].reason, /not a Safe/);
  const unbound = await run(card(), [{ network: XDC, payTo: SAFE }], chain(), { owner_of_key: null });
  assert.equal(unbound.results[0].outcome, 'not-bound');
});

test('no read at all when no payTo is the Safe; a card changed after pinning names no wallet', async () => {
  const evm = chain();
  const out = await run(card(), [{ network: XDC, payTo: account.address }], evm);
  assert.equal(out.results[0].outcome, 'verified-external-key');
  assert.equal(evm.calls.length, 0);
  clearConcordiumCache();
  const pinned = card();
  const served = card({ address: `${XDC}:${OTHER1}` });
  const changed = await verifyConcordiumPayees([{ network: XDC, payTo: OTHER1 }], { url: SELLER, safeFetch: pages({ [CARD_URL]: served }), fetchImpl: registry({ agent_by_token_address: agentRecord(pinned), owner_of_key: { owner_account: OWNER, status: 'Active' } }), evmCall: evm.evmCall });
  assert.equal(changed.results[0].outcome, 'card-mismatch');
  assert.equal(evm.calls.length, 0);
});

test('lookupBadge reports the smart wallet, read live; the badge stays valid either way', async () => {
  clearConcordiumCache();
  const text = card({ claim: 'one-of-n-owner', ownerCount: 3, threshold: 2 });
  const fetchImpl = registry({ agent_by_token_address: agentRecord(text), owner_of_key: { owner_account: OWNER, status: 'Active' } });
  const out = await lookupBadge(BADGE, { fetchImpl, safeFetch: pages({ [CARD_URL]: text }), evmCall: chain({ owners: [OTHER1, KEY_ADDR, OTHER2], threshold: 2 }).evmCall });
  assert.equal(out.valid, true);
  assert.deepEqual(out.external_key.smart_wallet, { network: XDC, address: SAFE, claim: 'one-of-n-owner', card: { owners: 3, threshold: 2 }, read: true, owners: 3, threshold: 2, key_is_owner: true, sole_controller: false, matches_card: true });
  clearConcordiumCache();
  const down = await lookupBadge(BADGE, { fetchImpl, safeFetch: pages({ [CARD_URL]: text }), evmCall: chain({ fail: 'timeout' }).evmCall });
  assert.equal(down.valid, true);
  assert.equal(down.external_key.smart_wallet.read, false);
});

test('the preflight check: pass, naming the smart wallet', async () => {
  clearConcordiumCache();
  const text = card();
  const checks = [];
  await checkConcordiumAgent([{ network: XDC, payTo: SAFE }], SELLER, checks, { safeFetch: pages({ [CARD_URL]: text }), fetchImpl: registry({ agent_by_token_address: agentRecord(text), owner_of_key: { owner_account: OWNER, status: 'Active' } }), evmCall: chain().evmCall });
  const c = checks.find((x) => x.id === 'concordium-agent');
  assert.equal(c.status, 'pass');
  assert.match(c.message, /verified-safe-owner \(a smart wallet the bound key solely controls/);
});
