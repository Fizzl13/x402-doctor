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
//   verified-safe-owner     payTo is the smart wallet (a Safe) the anchored card names, and the key the agent bound with
//                           CIS-8 is one of its owners right now (read live on that chain; owners and threshold as the
//                           card says)
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
const { base58Decode, NETWORKS: CHAINS } = require('./networks');

const REGISTRY_MCP = process.env.CONCORDIUM_REGISTRY_MCP || 'https://agent-registry-mcp.concordium.com/mcp';
// Concordium's indexer of the same registry (plain REST, no key, synced with the chain; /status says how far behind).
// Used only when the MCP service doesn't answer, so a badge check still works during its outage.
const REGISTRY_INDEXER = process.env.CONCORDIUM_REGISTRY_INDEXER || 'https://agent-registry-indexer.concordium.com';
const INDEXER_MAX_LAG_BLOCKS = 20; // ~40 s of Concordium blocks
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

// The token id inside a CIS-2 token address: version 2, the contract index and subindex (LEB128), then the token id
// (8 bytes little-endian for the registry's u64 ids), then a 4-byte checksum. Null for anything else.
function tokenIdOf(tokenAddress) {
  const b = base58Decode(tokenAddress);
  if (!b || b[0] !== 2) return null;
  let i = 1;
  for (let n = 0; n < 2; n += 1) {
    while (i < b.length && b[i] & 0x80) i += 1;
    i += 1;
  }
  const id = b.slice(i, b.length - 4);
  if (id.length !== 8) return null;
  let v = 0n;
  for (let k = 7; k >= 0; k -= 1) v = (v << 8n) | BigInt(id[k]);
  return v.toString();
}

// One agent from the indexer, the same fields as agent_by_token_address except external_reference (the CIS-8 key
// binding), so a payee that only a bound key would verify is not verified this way. Refused when the indexer is
// more than INDEXER_MAX_LAG_BLOCKS behind the chain: an old record could still show a revoked agent as active.
async function indexerAgent(tokenAddress, network, { fetchImpl = globalThis.fetch } = {}) {
  const id = tokenIdOf(tokenAddress);
  if (id === null) throw new Error('not a registry token address');
  const get = async (path) => {
    const res = await fetchImpl(`${REGISTRY_INDEXER}${path}`, { headers: { accept: 'application/json', 'user-agent': 'x402-doctor (x402-doctor.fizzl.eu)' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
    return JSON.parse(await res.text());
  };
  const status = await get('/status');
  const lag = status?.networks?.[network]?.lag_blocks;
  if (typeof lag !== 'number' || lag > INDEXER_MAX_LAG_BLOCKS) throw new Error(`indexer ${typeof lag === 'number' ? `${lag} blocks behind` : 'sync state unknown'}`);
  const body = await get(`/agents/${id}?network=${encodeURIComponent(network)}`);
  return body?.agent || null;
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

// secp256k1: a compressed public key (02/03 and x) as the uncompressed 04||x||y. y² = x³ + 7 mod p, and as p ≡ 3 (mod 4)
// the root is (x³ + 7)^((p + 1) / 4); the prefix says whether y is even (02) or odd (03). Null when x is not on the curve.
const SECP_P = 2n ** 256n - 2n ** 32n - 977n;
function modPow(b, e, m) { let r = 1n; b %= m; for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; } return r; }
function decompressSecp256k1(hex) {
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) return null;
  const x = BigInt(`0x${hex.slice(2)}`);
  if (x >= SECP_P) return null;
  const rhs = (modPow(x, 3n, SECP_P) + 7n) % SECP_P;
  let y = modPow(rhs, (SECP_P + 1n) / 4n, SECP_P);
  if ((y * y) % SECP_P !== rhs) return null;
  if ((y & 1n) !== BigInt(hex[1] === '3' ? 1 : 0)) y = SECP_P - y;
  return `04${hex.slice(2)}${y.toString(16).padStart(64, '0')}`;
}

// The address of a CIS-8 bound key on its own chain: EVM from the secp256k1 key (uncompressed or compressed, as
// several registry fleets bind it), Solana from ed25519.
function externalKeyAddress(key) {
  if (!key || typeof key.public_key_hex !== 'string') return null;
  const hex = key.public_key_hex.replace(/^0x/, '').toLowerCase();
  const type = String(key.key_type || '').toLowerCase();
  try {
    if (type.includes('secp256k1') && type.includes('uncompressed')) return publicKeyToAddress(`0x${hex.length === 128 ? `04${hex}` : hex}`).toLowerCase();
    if (type.includes('secp256k1') && type.includes('compressed')) {
      const full = decompressSecp256k1(hex);
      return full ? publicKeyToAddress(`0x${full}`).toLowerCase() : null;
    }
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
  let readVia = 'registry';
  try {
    a = await registryCall('agent_by_token_address', { token_address: badge.tokenAddress, network }, { fetchImpl });
  } catch (err) {
    // The MCP service is down or erroring: Concordium's indexer of the same registry, if it is in sync.
    try { a = await indexerAgent(badge.tokenAddress, network, { fetchImpl }); readVia = 'indexer'; } catch { return { error: err.message }; }
  }
  if (!a) return { missing: true };
  // 'unpinned': the agent has no card hash on chain (setAgentURI never anchored one), so no card can be checked.
  const pinned = /^[0-9a-f]{64}$/i.test(String(a.metadata_hash_hex || ''));
  let card = pinned ? 'unread' : 'unpinned';
  let anchored = null;
  if (typeof a.agent_uri === 'string' && pinned && safeFetch) {
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
    ...(readVia === 'indexer' ? { readVia } : {}),
  };
}

// A smart-contract wallet the bound key controls: Concordium's documented two-leg pattern (XDC AI runs it in production,
// docs.concordium.com, "How XDC AI verifies agent wallets on Concordium"). A Safe has no key of its own, so CIS-8 binds
// the key that owns it, and the anchored card names the wallet in an A2A extension: params.wallet.address (a CAIP-10
// eip155 account), params.ownerKey.publicKey (the key bound with CIS-8), and the owner count and threshold it expects.
// The card says what to expect; only a live read on that chain says what is true now, so it is never cached.
const SAFE_SELECTORS = { getOwners: '0xa0e67e2b', getThreshold: '0xe75235b8' };
const SMART_WALLET_RPC = { 'eip155:50': () => process.env.XDC_RPC_URL || 'https://rpc.xinfin.network' };
const asCount = (v) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function cardSmartWallet(card, key) {
  if (!card || typeof key?.public_key_hex !== 'string') return null;
  const want = key.public_key_hex.replace(/^0x/, '').toLowerCase();
  for (const e of card.capabilities?.extensions || []) {
    const p = e?.params;
    const m = /^(eip155:\d+):(0x[0-9a-fA-F]{40})$/.exec(String(p?.wallet?.address || ''));
    if (!m || String(p?.ownerKey?.publicKey || '').replace(/^0x/, '').toLowerCase() !== want) continue;
    return { network: m[1], address: m[2].toLowerCase(), claim: typeof p.claim === 'string' ? p.claim : null, ownerCount: asCount(p.wallet.ownerCount), threshold: asCount(p.wallet.threshold), extension: typeof e.uri === 'string' ? e.uri : null };
  }
  return null;
}

async function evmCallLatest(network, to, data) {
  const url = SMART_WALLET_RPC[network]?.() || CHAINS[network]?.rpc;
  if (!url) throw new Error(`no RPC for ${network}`);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'x402-doctor (x402-doctor.fizzl.eu)' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'RPC error');
  return body.result;
}

// The wallet's owners and threshold, live. { owners, threshold, keyIsOwner, sole, matchesCard } or { error }.
async function readSmartWallet(wallet, keyAddr, { evmCall = evmCallLatest } = {}) {
  try {
    const [ownersHex, thresholdHex] = await Promise.all([evmCall(wallet.network, wallet.address, SAFE_SELECTORS.getOwners), evmCall(wallet.network, wallet.address, SAFE_SELECTORS.getThreshold)]);
    const words = String(ownersHex || '').replace(/^0x/, '').match(/.{64}/g) || [];
    const count = words.length >= 2 ? Number(BigInt(`0x${words[1]}`)) : NaN;
    if (!Number.isInteger(count) || count < 1 || count > 64 || words.length < 2 + count) return { error: 'not a Safe (getOwners gave no owner list)' };
    const owners = words.slice(2, 2 + count).map((w) => `0x${w.slice(24)}`.toLowerCase());
    const threshold = Number(BigInt(String(thresholdHex || '0x0')));
    if (!threshold) return { error: 'not a Safe (no threshold)' };
    const matchesCard = (wallet.ownerCount === null || wallet.ownerCount === owners.length) && (wallet.threshold === null || wallet.threshold === threshold);
    return { owners, threshold, keyIsOwner: owners.includes(keyAddr), sole: owners.length === 1 && threshold === 1, matchesCard };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

const smartWalletView = (wallet, live) => ({
  network: wallet.network, address: wallet.address, claim: wallet.claim,
  card: { owners: wallet.ownerCount, threshold: wallet.threshold },
  ...(live?.error ? { read: false, error: live.error } : live ? { read: true, owners: live.owners.length, threshold: live.threshold, key_is_owner: live.keyIsOwner, sole_controller: live.sole, matches_card: live.matchesCard } : { read: false }),
});
const caipNetwork = (n) => {
  const s = String(n || '');
  if (/^eip155:\d+$/.test(s)) return s;
  try { return require('./payee').caipOf(s); } catch { return s; }
};

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
async function verifyConcordiumPayees(accepts, { url, safeFetch, fetchImpl, evmCall } = {}) {
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
  if (agent.card === 'unpinned') return { agent: view, results: all('not-read', 'the agent has no card hash on chain (never pinned), so its card cannot be checked') };
  // The endpoint must be the agent's own: listed in the anchored card, or the host of agent_uri itself. A card copied
  // to another server carries the same badge, so the badge alone proves nothing about who answers here.
  let uriOrigin = null;
  try { uriOrigin = new URL(agent.agentUri).origin.toLowerCase(); } catch { /* no uri */ }
  if (uriOrigin !== origin && !cardOrigins(anchoredCard).has(origin)) return { agent: view, results: all('endpoint-unlisted', `the agent's card does not list ${origin}`) };
  const keyAddr = externalKeyAddress(agent.externalKey);
  const bound = keyAddr ? await keyStillBound(agent.externalKey, agent.network, agent.owner, { fetchImpl }) : false;
  // A payTo that is the smart wallet the anchored card names (on that same chain): read its owners live, once.
  const wallet = typeof keyAddr === 'string' ? cardSmartWallet(anchoredCard, agent.externalKey) : null;
  const isWallet = (x) => Boolean(wallet && caipNetwork(x.network) === wallet.network && String(x.payTo || '').toLowerCase() === wallet.address);
  const live = wallet && options.some(isWallet) ? await readSmartWallet(wallet, keyAddr, { evmCall }) : null;
  const results = each((x) => {
    if (isConcordiumNetwork(x.network)) {
      const payTo = plainAccount(x.payTo);
      if (agent.agentWallet && payTo === agent.agentWallet) return { outcome: 'verified-wallet' };
      if (!agent.agentWallet && payTo === agent.owner) return { outcome: 'owner-only' };
      if (!agent.agentWallet) return { outcome: 'no-agent-wallet' };
      return { outcome: 'mismatch' };
    }
    if (!keyAddr) return { outcome: 'not-bound', reason: 'the agent binds no external key (CIS-8) to compare a payTo on this chain with' };
    // One key belongs to one family of chains: a secp256k1 key to EVM payTos, an ed25519 key to Solana's. A payTo on
    // another chain can't be compared with it, which is not the same as a wrong payTo.
    const family = typeof keyAddr === 'string' ? 'eip155:' : 'solana:';
    if (!String(x.network || '').startsWith(family)) return { outcome: 'not-bound', reason: `the agent's CIS-8 key is for ${family === 'eip155:' ? 'EVM' : 'Solana'} payTos, not this chain` };
    if (isWallet(x)) {
      if (!live || live.error) return { outcome: 'not-read', reason: `the owners of the smart wallet the card names could not be read on ${wallet.network}${live?.error ? ` (${live.error})` : ''}` };
      if (!live.keyIsOwner) return { outcome: 'mismatch', reason: 'payTo is the smart wallet the card names, but the key the agent bound with CIS-8 is not one of its owners now' };
      if (!live.matchesCard) return { outcome: 'mismatch', reason: `the card says ${wallet.ownerCount ?? '?'} owner(s) and threshold ${wallet.threshold ?? '?'}; the wallet now has ${live.owners.length} and ${live.threshold}` };
      if (bound === null) return { outcome: 'not-read', reason: 'the CIS-8 key registry could not be read' };
      if (!bound) return { outcome: 'not-bound', reason: 'the agent names this key, but the CIS-8 registry holds no active binding of it to the agent\'s owner' };
      return { outcome: 'verified-safe-owner', reason: live.sole ? 'a smart wallet the bound key solely controls (read live)' : `a smart wallet with ${live.owners.length} owners, the bound key one of them, ${live.threshold} needed to sign (read live)`, wallet: smartWalletView(wallet, live) };
    }
    if (!sameExternal(keyAddr, x.payTo)) return { outcome: 'mismatch', reason: 'payTo is not the address of the key the agent bound with CIS-8' };
    if (bound === null) return { outcome: 'not-read', reason: 'the CIS-8 key registry could not be read' };
    return bound ? { outcome: 'verified-external-key' } : { outcome: 'not-bound', reason: 'the agent names this key, but the CIS-8 registry holds no active binding of it to the agent\'s owner' };
  });
  return { agent: view, results };
}

// A badge as an owner or another agent may paste it: the short CIS-2 token address, the card's
// "ccd:<genesis>/cis-2:<address>" form, or the "Agent ID" Concordium's registry app shows, which is the same Base58Check
// token address with the contract index, subindex and token id as fixed 8-byte numbers. Returns the short form, or
// null when the input is no CIS-2 token address (or its checksum is wrong).
function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const checksum4 = (body) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(body).digest()).digest().subarray(0, 4);
function leb128(n) {
  const out = [];
  do { let x = Number(n & 0x7fn); n >>= 7n; if (n) x |= 0x80; out.push(x); } while (n);
  return out;
}
function normalizeBadge(input) {
  const text = String(input ?? '').trim().replace(/^ccd:[0-9a-f]+\/cis-2:/i, '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{8,60}$/.test(text)) return null;
  const raw = base58Decode(text);
  if (!raw || raw.length < 6) return null;
  const bytes = Buffer.from(raw);
  const body = bytes.subarray(0, -4);
  if (!checksum4(body).equals(bytes.subarray(-4)) || body[0] !== 2) return null;
  if (body.length !== 25) return text;
  const u64 = (at) => body.readBigUInt64LE(at);
  const short = Buffer.from([2, ...leb128(u64(1)), ...leb128(u64(9)), ...body.subarray(17, 25)]);
  return base58Encode(Buffer.concat([short, checksum4(short)]));
}

// Everything an agent needs to judge a Concordium badge on its own, without an x402 endpoint: the agent on chain, its
// anchored card, the origins that card lists, the CIS-8 key it binds (with the address it stands for and whether the
// CIS-8 registry still holds it), and whether the badge is valid as Concordium defines it (Active, card hash on chain,
// the card carries this badge). Read-only.
// The Agent Safety Index (exam.fizzl.eu) for the sites an anchored card lists. The chain: the Concordium badge vouches
// for the card's origins; a site's /.well-known/agent-safety.json vouches for the operator wallet that took the exam
// (the index marks those results verified). Only verified results count. The best is a current admission, else the
// latest. Informational: it never changes whether the badge is valid. null when nothing is found or the index is down.
const EXAM_URL = 'https://exam.fizzl.eu';
async function examFor(origins, { fetchImpl = globalThis.fetch, base = EXAM_URL, timeoutMs = 5000 } = {}) {
  const hosts = [...new Set(origins.map((o) => { try { return new URL(o).hostname; } catch { return null; } }).filter(Boolean))].slice(0, 3);
  for (const host of hosts) {
    const r = await fetchImpl(`${base}/v1/lookup?site=${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(timeoutMs) })
      .then((res) => (res.ok ? res.json() : null)).catch(() => null);
    const verified = (Array.isArray(r?.agents) ? r.agents : []).filter((a) => a && a.verified === true);
    if (!verified.length) continue;
    const latest = (a, b) => String(b.finished_at ?? '').localeCompare(String(a.finished_at ?? ''));
    const best = verified.filter((a) => a.admitted && a.current).sort(latest)[0] ?? verified.sort(latest)[0];
    return {
      site: host,
      agent: best.agent?.name ?? null,
      admitted: best.admitted === true,
      current: best.current === true,
      score: typeof best.score === 'number' ? best.score : null,
      traps_avoided: best.traps_avoided ?? null,
      valid_until: best.valid_until ?? null,
      agent_page: best.agent_page ?? null,
      result: best.result ?? null,
    };
  }
  return null;
}

async function lookupBadge(input, { fetchImpl, safeFetch, exam = false, examFetch, evmCall, mandate = null } = {}) {
  const tokenAddress = normalizeBadge(input);
  if (!tokenAddress) return { badge: String(input ?? '').trim(), valid: false, issues: ['not a CIS-2 token address (badge or Agent ID), or its checksum is wrong'] };
  const agent = await resolveAgent({ tokenAddress, chain: null }, { fetchImpl, safeFetch });
  const out = { badge: tokenAddress, valid: false, issues: [] };
  if (agent.foreign) return { ...out, issues: ['not a token of the official Concordium Agent Registry (mainnet <10082,0> or testnet <12802,0>)'] };
  if (agent.error) return { ...out, issues: [`registry: ${agent.error}`] };
  if (agent.missing) return { ...out, issues: ['no agent with this badge in the registry'] };
  const { anchoredCard, externalKey, ...view } = agent;
  const inCard = anchoredCard ? cardBadge(anchoredCard) : null;
  const keyAddr = externalKeyAddress(externalKey);
  const bound = keyAddr ? await keyStillBound(externalKey, agent.network, agent.owner, { fetchImpl }) : null;
  const issues = [];
  if (agent.status !== 'Active') issues.push(`registry status ${agent.status}`);
  if (agent.card === 'mismatch') issues.push('the card at agent_uri does not hash to the metadata_hash on chain (changed after pinning, or swapped)');
  if (agent.card === 'unread') issues.push('the card at agent_uri could not be read');
  if (agent.card === 'unpinned') issues.push('no card hash on chain (the card was never pinned with setAgentURI)');
  if (agent.card === 'match' && inCard?.tokenAddress !== tokenAddress) issues.push('the anchored card does not carry this badge');
  const origins = anchoredCard ? [...cardOrigins(anchoredCard)] : [];
  const examResult = exam && agent.card === 'match' && origins.length ? await examFor(origins, { fetchImpl: examFetch }) : null;
  // A smart wallet the anchored card names for the bound key, with its owners read live (informational: the badge's
  // validity doesn't depend on it).
  const wallet = typeof keyAddr === 'string' ? cardSmartWallet(anchoredCard, externalKey) : null;
  const smartWallet = wallet ? smartWalletView(wallet, await readSmartWallet(wallet, keyAddr, { evmCall })) : null;
  // The owner's spending rules, from the anchored card only (informational: validity doesn't depend on them).
  const rules = agent.card === 'match' ? cardRules(anchoredCard) : null;
  return {
    ...out,
    ...view,
    valid: issues.length === 0,
    issues,
    card_origins: origins,
    ...(exam ? { exam: examResult } : {}),
    spending_rules: rules ? { pinned_by: agent.owner, ...rules } : null,
    ...(mandate ? { mandate_check: checkMandate(mandate, rules) } : {}),
    external_key: externalKey ? {
      namespace: externalKey.namespace ?? null,
      key_type: externalKey.key_type ?? null,
      address: typeof keyAddr === 'string' ? keyAddr : keyAddr?.solana ? base58Encode(Buffer.from(keyAddr.solana, 'hex')) : null,
      still_bound: bound,
      ...(smartWallet ? { smart_wallet: smartWallet } : {}),
    } : null,
  };
}

// The owner's spending rules an anchored card carries (the Fizzl Agent Wallet puts them in an agent's own card,
// extension https://fizzl.eu/a2a/spending-rules/v1): the key that signs the agent's x402 mandates (x402-mandate/1,
// Ed25519), the limits per token and the agent's current mandate. Read only from a card whose hash is on chain, so
// they are what the owner's account pinned.
const RULES_EXT = 'https://fizzl.eu/a2a/spending-rules/v1';
function cardRules(card) {
  const p = (card?.capabilities?.extensions || []).find((e) => e?.uri === RULES_EXT)?.params;
  if (!p || typeof p !== 'object') return null;
  return { issuer: typeof p.issuer === 'string' ? p.issuer : null, limits: p.limits ?? null, mandate: p.mandate ?? null };
}

// RFC 8785 (JCS) for the mandate object (strings, string arrays and plain objects), as the wallet signs it.
const jcs = (v) => (Array.isArray(v) ? `[${v.map(jcs).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`
  : JSON.stringify(v));
const sixDecimals = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!/^\d+$/.test(s)) return null;
  const n = s.padStart(7, '0');
  return `${n.slice(0, -6).replace(/^0+(?=\d)/, '')}.${n.slice(-6)}`.replace(/\.?0+$/, '');
};

// A signed x402-mandate/1 envelope ({ mandate, alg, sig }) held against the rules the owner pinned: is it signed by the
// anchored key, and is it the anchored mandate (same nonce, budget, per-payment limit and end date)? It says whose the
// mandate is and that its signature holds; what a payment may spend is in the mandate itself.
function checkMandate(envelope, rules) {
  const m = envelope?.mandate;
  if (!m || typeof m !== 'object' || m.v !== 'x402-mandate/1') return { match: false, signature_valid: null, reason: 'not an x402-mandate/1 envelope ({ mandate, alg, sig })' };
  let signatureValid = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(m.issuer) }, format: 'jwk' });
    signatureValid = envelope.alg === 'Ed25519' && crypto.verify(null, Buffer.from(`x402-mandate/1\n${jcs(m)}`, 'utf8'), key, Buffer.from(String(envelope.sig || ''), 'base64url'));
  } catch { signatureValid = false; }
  const out = (match, reason) => ({ match, signature_valid: signatureValid, ...(reason ? { reason } : {}) });
  if (!signatureValid) return out(false, 'the signature does not hold for the key it names');
  if (!rules?.issuer) return out(false, 'the anchored card carries no spending rules');
  if (m.issuer !== rules.issuer) return out(false, 'signed by another key than the one the owner pinned on Concordium');
  if (!rules.mandate) return out(false, 'the owner pinned no mandate for this agent');
  if (m.nonce !== rules.mandate.nonce) return out(false, 'not the mandate the owner pinned (another nonce)');
  if (sixDecimals(m.cap) !== String(rules.mandate.cap) || sixDecimals(m.perPayment ?? null) !== (rules.mandate.perPayment ?? null) || m.notAfter !== rules.mandate.notAfter) {
    return out(false, 'its terms differ from the pinned ones');
  }
  return out(true);
}

function clearConcordiumCache() { cache.clear(); }

module.exports = { tokenIdOf, indexerAgent, cardRules, checkMandate, verifyConcordiumPayees, resolveAgent, lookupBadge, cardSmartWallet, readSmartWallet, examFor, normalizeBadge, badgeNetwork, cardBadge, cardOrigins, externalKeyAddress, registryCall, isConcordiumNetwork, isConcordiumAccount, sha256Hex, NETWORKS, clearConcordiumCache };
