'use strict';

// Verified by Concordium: is the seller behind an x402 endpoint a registered, active agent with an accountable
// owner, and is each payTo the wallet that agent registered?
//
// Concordium's Agent Registry (CIS-8004, the Concordium form of ERC-8004) mints each agent as an NFT owned by a
// Concordium account, and every Concordium account is tied to a verified identity at the protocol level. The
// agent's "badge" is that NFT's token address; its Agent Card (an ERC-8004 registration file that is also an A2A
// Agent Card) carries the badge as an A2A extension and is anchored on chain by its SHA-256 (metadata_hash).
//
// For an endpoint, we read the seller's Agent Card at /.well-known/agent-card.json, take the badge from it, resolve
// it on chain through Concordium's hosted Agent Registry service (read-only), and per payment option return one
// outcome, never a score:
//   verified-wallet         payTo is the agent wallet registered for the badge (a Concordium account)
//   verified-external-key   payTo on another chain is the address of the key the agent bound with CIS-8
//   owner-only              payTo is the agent's owner account, and no agent wallet is set (not verified)
//   mismatch                payTo is neither
//   not-bound               payTo on another chain, and the agent binds no external key (nothing to compare)
//   revoked                 the agent is not Active in the registry
//   card-mismatch           the card at agent_uri doesn't hash to the metadata_hash on chain (changed or swapped)
//   endpoint-unlisted       the anchored card doesn't list this endpoint's origin, so it could be anyone's server
//   no-agent-wallet         Concordium payTo, but the agent has no wallet and payTo isn't the owner
//   not-read                the registry or the card couldn't be read (never a pass or a fail)
// Read-only: one card fetch and a few registry reads; nothing is signed or paid.

const crypto = require('node:crypto');
const { publicKeyToAddress } = require('viem/accounts');
const { base58Decode } = require('./networks');

const REGISTRY_MCP = process.env.CONCORDIUM_REGISTRY_MCP || 'https://agent-registry-mcp.concordium.com/mcp';
const BADGE_EXTENSION = 'concordium-badge/v1';
// CAIP-2 ids: ccd:<first 32 hex characters of the genesis hash>.
const NETWORKS = {
  'ccd:9dd9ca4d19e9393877d2c44b70f89acb': { id: 'mainnet', name: 'Concordium', registry: '10082,0' },
  'ccd:4221332d34e1694168c2a0c0b3fd0f27': { id: 'testnet', name: 'Concordium testnet', registry: '12802,0' },
};
const BY_ID = Object.fromEntries(Object.entries(NETWORKS).map(([caip, n]) => [n.id, { caip, ...n }]));
const BY_REGISTRY_INDEX = Object.fromEntries(Object.values(NETWORKS).map((n) => [Number(n.registry.split(',')[0]), n.id]));
const TIMEOUT_MS = 8000;
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const isConcordiumNetwork = (n) => typeof n === 'string' && n.startsWith('ccd:');
// Concordium account addresses: Base58Check, 50 characters, starting with 2–4.
const isConcordiumAccount = (a) => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{50}$/.test(a);
const sha256Hex = (text) => crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');

// One MCP tool call on the registry service: JSON-RPC 2.0 over Streamable HTTP (JSON or one SSE event).
async function registryCall(tool, args, { fetchImpl = globalThis.fetch } = {}) {
  const key = `${tool}:${JSON.stringify(args)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetchImpl(REGISTRY_MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'x402-doctor (x402-doctor.fizzl.eu)' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  let text = await res.text();
  if (/^\s*(event|data):/.test(text)) text = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  const body = JSON.parse(text);
  if (body.error) throw new Error(body.error.message || 'registry error');
  if (body.result?.isError) throw new Error((body.result.content || []).map((c) => c.text).join(' ').slice(0, 200) || 'registry error');
  const out = (body.result?.content || []).map((c) => c.text || '').join('');
  const value = out && out !== 'null' ? JSON.parse(out) : null;
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

// The badge an Agent Card carries: the A2A extension's params (token address, chain), or a legacy top-level block.
function cardBadge(card) {
  if (!card || typeof card !== 'object') return null;
  const ext = (card.capabilities?.extensions || []).find((e) => typeof e?.uri === 'string' && e.uri.includes(BADGE_EXTENSION));
  const p = ext?.params || card.concordium || null;
  if (!p || typeof p !== 'object') return null;
  // The token address in its short form, or the CAIP-19 form ccd:<genesis>/cis-2:<short>.
  const raw = p.tokenAddress || p.token_address || p.badge || p.id || null;
  const caip = typeof raw === 'string' && raw.includes('/cis-2:') ? raw : typeof p.caip19 === 'string' ? p.caip19 : null;
  const short = caip ? caip.split('/cis-2:')[1] : typeof raw === 'string' ? raw : null;
  const chain = caip ? caip.split('/')[0] : typeof p.chain === 'string' ? p.chain : null;
  if (!short || !/^[1-9A-HJ-NP-Za-km-z]{8,40}$/.test(short)) return null;
  return { tokenAddress: short, chain: chain && NETWORKS[chain] ? chain : null };
}

// The origins an Agent Card lists as its own: A2A interfaces, ERC-8004 services, and the card's url.
function cardOrigins(card) {
  const urls = [
    card?.url,
    ...(card?.supportedInterfaces || []).map((i) => i?.url),
    ...(card?.services || []).map((s) => s?.endpoint),
    ...(card?.endpoints || []).map((s) => s?.endpoint),
  ];
  const out = new Set();
  for (const u of urls) {
    try { const x = new URL(u); if (/^https?:$/.test(x.protocol)) out.add(x.origin.toLowerCase()); } catch { /* not a URL */ }
  }
  return out;
}

// Which official registry a badge belongs to: a CIS-2 token address is Base58Check of version byte 2, the contract
// index and subindex (LEB128), then the token id. Returns 'mainnet', 'testnet' or null (another contract).
function badgeNetwork(tokenAddress) {
  const b = base58Decode(tokenAddress);
  if (!b || b.length < 7 || b[0] !== 2) return null;
  let index = 0;
  let shift = 0;
  for (let i = 1; i < b.length - 4 && i < 10; i += 1) {
    index += (b[i] & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b[i] & 0x80)) return BY_REGISTRY_INDEX[index] || null;
  }
  return null;
}

// The address of a CIS-8 bound key on its own chain: EVM from the uncompressed secp256k1 key, Solana from ed25519.
function externalKeyAddress(key) {
  if (!key || typeof key.public_key_hex !== 'string') return null;
  const hex = key.public_key_hex.replace(/^0x/, '').toLowerCase();
  const type = String(key.key_type || '').toLowerCase();
  try {
    if (type.includes('secp256k1') && type.includes('uncompressed')) return publicKeyToAddress(`0x${hex.length === 128 ? `04${hex}` : hex}`).toLowerCase();
    if (type === 'ed25519' && hex.length === 64) return { solana: hex };
  } catch { /* not a key */ }
  return null;
}
function sameExternal(addr, payTo) {
  if (!addr || typeof payTo !== 'string') return false;
  if (typeof addr === 'string') return addr === payTo.toLowerCase();
  const bytes = base58Decode(payTo);
  return Boolean(bytes && bytes.length === 32 && Buffer.from(bytes).toString('hex') === addr.solana);
}

// Reads the seller's card at /.well-known/agent-card.json. Returns { card, text, url } or null.
async function readCard(origin, safeFetch) {
  const url = `${origin}/.well-known/agent-card.json`;
  try {
    const res = await safeFetch(url, { headers: { accept: 'application/json' } });
    if (res.status !== 200) return null;
    return { card: JSON.parse(res.text), text: res.text, url };
  } catch {
    return null;
  }
}

// The agent behind a badge, on chain, with its anchored card: the card at agent_uri, kept only when its SHA-256 is
// the metadata_hash on chain (card: 'match' | 'mismatch' | 'unread').
async function resolveAgent(badge, { fetchImpl, safeFetch } = {}) {
  // The badge's own contract decides the network; a chain the card claims must agree with it.
  const network = badgeNetwork(badge.tokenAddress);
  if (!network || (badge.chain && NETWORKS[badge.chain].id !== network)) return { foreign: true };
  let a;
  try { a = await registryCall('agent_by_token_address', { token_address: badge.tokenAddress, network }, { fetchImpl }); } catch (err) { return { error: err.message }; }
  if (!a) return { missing: true };
  let card = 'unread';
  let anchored = null;
  if (typeof a.agent_uri === 'string' && /^[0-9a-f]{64}$/i.test(String(a.metadata_hash_hex || '')) && safeFetch) {
    try {
      const res = await safeFetch(a.agent_uri, { headers: { accept: 'application/json' } });
      if (res.status === 200) {
        card = sha256Hex(res.text) === String(a.metadata_hash_hex).toLowerCase() ? 'match' : 'mismatch';
        if (card === 'match') { try { anchored = JSON.parse(res.text); } catch { anchored = null; } }
      }
    } catch { card = 'unread'; }
  }
  return {
    network, chain: BY_ID[network].caip, registry: BY_ID[network].registry,
    tokenAddress: badge.tokenAddress, tokenId: a.token_id ?? null,
    owner: a.owner_account ?? null, agentWallet: a.agent_wallet ?? null, status: a.status ?? null,
    agentUri: a.agent_uri ?? null, card, anchoredCard: anchored, externalKey: a.external_reference?.key || null,
  };
}

// A CIS-8 key binding is real only while the CIS-8 registry holds it: an agent's external_reference alone is a claim.
async function keyStillBound(key, network, owner, { fetchImpl } = {}) {
  try {
    const reg = await registryCall('owner_of_key', { external_key: { namespace: key.namespace, key_type: key.key_type, public_key_hex: key.public_key_hex }, network }, { fetchImpl });
    if (!reg) return false;
    if (reg.status && reg.status !== 'Active') return false;
    const holder = reg.owner_account || reg.owner || reg.account || null;
    return holder ? holder === owner : true;
  } catch {
    return null;
  }
}

// A Concordium payTo as a plain account address (an x402 option may also carry the CAIP-10 form ccd:<genesis>:<account>).
const plainAccount = (payTo) => (typeof payTo === 'string' ? payTo.replace(/^ccd:[0-9a-f]{32}:/i, '') : payTo);

// Per payment option, its outcome against the agent behind the card's badge.
async function verifyConcordiumPayees(accepts, { url, safeFetch, fetchImpl } = {}) {
  let origin;
  try { origin = new URL(url).origin.toLowerCase(); } catch { return { agent: null, results: [] }; }
  const read = await readCard(origin, safeFetch);
  const badge = read && cardBadge(read.card);
  if (!badge) return { agent: null, results: [] };
  const agent = await resolveAgent(badge, { fetchImpl, safeFetch });
  const options = (Array.isArray(accepts) ? accepts : []).filter((x) => x && typeof x === 'object');
  const each = (fn) => options.map((x) => ({ network: x.network ?? null, payTo: x.payTo ?? null, ...fn(x) }));
  const all = (outcome, reason) => each(() => ({ outcome, ...(reason ? { reason } : {}) }));
  const stub = { tokenAddress: badge.tokenAddress };
  if (agent.error) return { agent: stub, results: all('not-read', `registry: ${agent.error}`) };
  if (agent.foreign) return { agent: stub, results: all('not-read', 'the badge is not a token of the official Concordium Agent Registry') };
  if (agent.missing) return { agent: stub, results: all('not-read', 'the badge resolves to no agent in the official registry') };
  const { anchoredCard, ...view } = agent;
  if (agent.status !== 'Active') return { agent: view, results: all('revoked', `registry status ${agent.status}`) };
  if (agent.card === 'mismatch') return { agent: view, results: all('card-mismatch', 'the card at agent_uri does not hash to the metadata_hash on chain') };
  if (agent.card === 'unread') return { agent: view, results: all('not-read', 'the card at agent_uri could not be read and checked against the hash on chain') };
  // The endpoint must be the agent's own: listed in the anchored card, or the host of agent_uri itself. A card copied
  // to another server carries the same badge, so the badge alone proves nothing about who answers here.
  let uriOrigin = null;
  try { uriOrigin = new URL(agent.agentUri).origin.toLowerCase(); } catch { /* no uri */ }
  if (uriOrigin !== origin && !cardOrigins(anchoredCard).has(origin)) return { agent: view, results: all('endpoint-unlisted', `the agent's card does not list ${origin}`) };
  const keyAddr = externalKeyAddress(agent.externalKey);
  const bound = keyAddr ? await keyStillBound(agent.externalKey, agent.network, agent.owner, { fetchImpl }) : false;
  const results = each((x) => {
    if (isConcordiumNetwork(x.network)) {
      const payTo = plainAccount(x.payTo);
      if (agent.agentWallet && payTo === agent.agentWallet) return { outcome: 'verified-wallet' };
      if (!agent.agentWallet && payTo === agent.owner) return { outcome: 'owner-only' };
      if (!agent.agentWallet) return { outcome: 'no-agent-wallet' };
      return { outcome: 'mismatch' };
    }
    if (!keyAddr) return { outcome: 'not-bound', reason: 'the agent binds no external key (CIS-8) to compare a payTo on this chain with' };
    if (!sameExternal(keyAddr, x.payTo)) return { outcome: 'mismatch', reason: 'payTo is not the address of the key the agent bound with CIS-8' };
    if (bound === null) return { outcome: 'not-read', reason: 'the CIS-8 key registry could not be read' };
    return bound ? { outcome: 'verified-external-key' } : { outcome: 'not-bound', reason: 'the agent names this key, but the CIS-8 registry holds no active binding of it to the agent\'s owner' };
  });
  return { agent: view, results };
}

function clearConcordiumCache() { cache.clear(); }

module.exports = { verifyConcordiumPayees, resolveAgent, badgeNetwork, cardBadge, cardOrigins, externalKeyAddress, registryCall, isConcordiumNetwork, isConcordiumAccount, sha256Hex, NETWORKS, clearConcordiumCache };
