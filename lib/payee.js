'use strict';

// x402 payee verification for ERC-8004 agents (ERC-8478, draft ethereum/ERCs#2132; this follows the text after the
// editor review of 27 Nov 2026: version 2 delegations with walletSetAt, at most 90 days, payees list binds; the v1
// transition was dropped, so a version 1 delegation is invalid-delegation): is the payTo of a payment
// requirement bound to the ERC-8004 identity the payer means to pay? Bound means the resource's origin is listed in
// the identity's registration file, and the payTo is the agent wallet (getAgentWallet) or is covered by an EIP-712
// payee delegation the agent wallet signed. One outcome per requirement, never a score:
//   verified-wallet, verified-delegation, mismatch, invalid-delegation, endpoint-unlisted, owner-only,
//   no-agent-wallet, no-identity, not-read (a failed read is never a pass or a fail). owner-only (no agent wallet,
//   payTo is the identity's owner on the registry's chain) is never verified: an owner may be a marketplace or a cold key.
// Read-only: eth_call / eth_getCode on the registry's chain and one fetch of the registration file.

const { recoverTypedDataAddress, hashTypedData } = require('viem');

const OUTCOMES = ['verified-wallet', 'verified-delegation', 'mismatch', 'invalid-delegation', 'endpoint-unlisted', 'owner-only', 'no-agent-wallet', 'no-identity', 'not-read'];
const DELEGATION_TYPES = {
  PayeeDelegation: [
    { name: 'chainId', type: 'uint256' },
    { name: 'registry', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'agentWallet', type: 'address' },
    { name: 'walletSetAt', type: 'uint64' },
    { name: 'network', type: 'string' },
    { name: 'payTo', type: 'string' },
    { name: 'asset', type: 'string' },
    { name: 'origin', type: 'string' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
const MAX_VALIDITY_S = 7_776_000; // 90 days
const DOMAIN_VERSION = '2';
// Section 3's rules, in the order a checker evaluates them; the first that fails is reported as delegationRule.
const RULES = ['identity', 'agent-wallet', 'wallet-set-at', 'window', 'network', 'pay-to', 'asset', 'origin', 'not-declared', 'signature'];
// ERC-8004's MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)
// and keccak256("agentWallet"): the event every agent wallet setting emits (register, setAgentWallet, unset, transfer).
const METADATA_SET_TOPIC = '0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b';
const AGENT_WALLET_KEY_TOPIC = '0x2ac6109326e720d1435c0db66f7e35eda7839f52b6f1f5520a60788e132b4e39';
const SEL = { tokenURI: '0xc87b56dd', getAgentWallet: '0x00339509', ownerOf: '0x6352211e', isValidSignature: '0x1626ba7e' };
const ERC1271_MAGIC = '0x1626ba7e';

// x402 v1 network names → CAIP-2, so a v1 402 ("network": "base") is compared like a v2 one ("eip155:8453").
const V1_EVM = { base: 8453, 'base-sepolia': 84532, ethereum: 1, optimism: 10, polygon: 137, arbitrum: 42161, avalanche: 43114, bsc: 56, 'x-layer': 196, xlayer: 196 };
const caipOf = (network) => { const n = String(network ?? ''); return V1_EVM[n.toLowerCase()] ? `eip155:${V1_EVM[n.toLowerCase()]}` : n; };
const isHexAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a, b) => (isHexAddr(a) && isHexAddr(b) ? a.toLowerCase() === b.toLowerCase() : String(a) === String(b));
const hex64 = (n) => BigInt(n).toString(16).padStart(64, '0');

// "https://host[:port]" with the host in lower case and its ASCII (punycode) form, as URL gives it.
function originOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.host.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

// Where to fetch a tokenURI: an ipfs:// one through a public gateway (ipfs.io and dweb.link answer 429 to servers
// since Oct 2026), anything else as it is.
const IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
function docUrl(uri) {
  const m = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(String(uri || ''));
  return m ? `${IPFS_GATEWAY}${m[1]}` : String(uri || '');
}

// The registration file's endpoint origins (services[].endpoint, and the older endpoints[].endpoint).
function endpointOrigins(doc) {
  const list = [...(Array.isArray(doc?.services) ? doc.services : []), ...(Array.isArray(doc?.endpoints) ? doc.endpoints : [])];
  return new Set(list.map((s) => originOf(s?.endpoint)).filter(Boolean));
}

// Section 6: the payees a seller declares under its x402 service, with their delegations.
function declaredPayees(doc) {
  const out = [];
  for (const s of Array.isArray(doc?.services) ? doc.services : []) {
    for (const p of Array.isArray(s?.payees) ? s.payees : []) if (p && typeof p.network === 'string' && typeof p.payTo === 'string') out.push(p);
  }
  return out;
}

// Whether the registration file has a payees list at all (an empty one counts): only then is payee-not-declared noted.
function hasPayeesList(doc) {
  return (Array.isArray(doc?.services) ? doc.services : []).some((s) => Array.isArray(s?.payees));
}
const declares = (doc, network, payTo) => declaredPayees(doc).some((p) => (p.network === network || caipOf(p.network) === caipOf(network)) && same(p.payTo, payTo));

// The decoded metadataValue of a MetadataSet event: 20 bytes (the address), or 32 (left-padded); empty or zero = none.
function decodeWalletValue(data) {
  // data = abi.encode(string metadataKey, bytes metadataValue)
  const h = word(data);
  try {
    const off = parseInt(h.slice(64, 128), 16) * 2;
    const len = parseInt(h.slice(off, off + 64), 16);
    const v = h.slice(off + 64, off + 64 + len * 2);
    if (len === 0) return null;
    const addr = len === 20 ? `0x${v}` : len === 32 && /^0{24}/.test(v) ? `0x${v.slice(24)}` : undefined;
    if (addr === undefined) return undefined; // cannot be decoded
    return /^0x0{40}$/.test(addr) ? null : addr;
  } catch {
    return undefined;
  }
}

// The identity a requirement names in extra.erc8004 ({ registry: "eip155:<chain>:<address>", agentId }), or null.
function namedIdentity(accept) {
  const e = accept?.extra?.erc8004;
  const m = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(String(e?.registry || ''));
  if (!m || !/^\d{1,30}$/.test(String(e?.agentId ?? ''))) return null;
  return { chainId: Number(m[1]), registry: m[2], agentId: String(e.agentId) };
}

const word = (hex) => String(hex || '').replace(/^0x/, '');
const addrFromWord = (hex) => {
  const w = word(hex);
  return w.length >= 64 ? `0x${w.slice(24, 64)}` : null;
};
function decodeAbiString(hex) {
  const h = word(hex);
  if (h.length < 128) return null;
  const len = parseInt(h.slice(64, 128), 16);
  if (!(len >= 0) || len > 4096 || h.length < 128 + len * 2) return null;
  return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
}
// No code, or only an EIP-7702 delegation designator (0xef0100…): an externally owned account, whose key controls the
// same address on every EVM chain. The draft's "no contract code" rule is read this way, since a 7702 account is still
// controlled by its key.
const isEoaCode = (code) => { const c = word(code).toLowerCase(); return c === '' || /^ef0100[0-9a-f]{40}$/.test(c); };

// Reads one identity at the latest block: agent wallet, its code (or, without an agent wallet, the identity's owner),
// the registration file (unless given) and block.
// Any failed read leaves `notRead` naming it.
async function readIdentity(id, { rpc, fetchDoc, doc = null }) {
  const network = `eip155:${id.chainId}`;
  const out = { ...id, network, block: null, agentWallet: null, walletCode: null, owner: null, doc, notRead: null, notReadKind: null };
  let step = 'registry (block)';
  const kind = (st) => (st === 'registration file' ? 'registration-file' : st === 'agent wallet code' ? 'code' : 'registry');
  try {
    out.block = parseInt(await rpc(network, 'eth_blockNumber', []), 16);
    const tag = `0x${out.block.toString(16)}`;
    step = 'registry (agent wallet)';
    out.agentWallet = addrFromWord(await rpc(network, 'eth_call', [{ to: id.registry, data: `${SEL.getAgentWallet}${hex64(id.agentId)}` }, tag]));
    if (out.agentWallet && /^0x0{40}$/.test(out.agentWallet)) out.agentWallet = null;
    step = out.agentWallet ? 'agent wallet code' : 'registry (owner)';
    if (out.agentWallet) out.walletCode = await rpc(network, 'eth_getCode', [out.agentWallet, tag]);
    else out.owner = addrFromWord(await rpc(network, 'eth_call', [{ to: id.registry, data: `${SEL.ownerOf}${hex64(id.agentId)}` }, tag]));
    if (out.owner && /^0x0{40}$/.test(out.owner)) out.owner = null;
    step = 'registration file';
    if (!out.doc) {
      const uri = decodeAbiString(await rpc(network, 'eth_call', [{ to: id.registry, data: `${SEL.tokenURI}${hex64(id.agentId)}` }, tag]));
      out.doc = uri ? await fetchDoc(uri) : null;
      if (!out.doc) { out.notRead = 'registration file'; out.notReadKind = 'registration-file'; }
    }
  } catch (err) {
    out.notRead = step;
    out.notReadKind = kind(step);
    out.error = String(err?.message || err).slice(0, 160);
  }
  return out;
}

// Section 3: is `delegation` ({ message, signature }) valid for this requirement? Returns null when valid, else
// { rule, reason } for the first rule it fails, or { notRead, reason } when a read the rules need failed.
// `walletEvent(identity, fromBlock)` gives the latest MetadataSet event for the agent wallet in [fromBlock, B] as
// { block, data }, or null when there is none in that range; it throws when the log can't be read.
async function delegationProblem(delegation, { identity, accept, origin, now, rpc, walletEvent }) {
  const m = delegation?.message, sig = delegation?.signature;
  const fail = (rule, reason) => ({ rule, reason });
  if (!m || typeof m !== 'object' || typeof sig !== 'string' || !/^0x[0-9a-fA-F]+$/.test(sig)) return fail('identity', 'not a { message, signature } delegation');
  if (m.walletSetAt === undefined || m.walletSetAt === null) return fail('wallet-set-at', 'a version 1 delegation (no walletSetAt): ERC-8478 now takes version 2 only; re-sign it');
  let message;
  try {
    message = {
      chainId: BigInt(m.chainId), registry: m.registry, agentId: BigInt(m.agentId), agentWallet: m.agentWallet, walletSetAt: BigInt(m.walletSetAt),
      network: String(m.network), payTo: String(m.payTo), asset: String(m.asset), origin: String(m.origin),
      validAfter: BigInt(m.validAfter), validUntil: BigInt(m.validUntil), nonce: m.nonce,
    };
    if (!isHexAddr(message.registry) || !isHexAddr(message.agentWallet) || !/^0x[0-9a-fA-F]{64}$/.test(String(message.nonce))) throw new Error('fields');
  } catch {
    return fail('identity', 'a field is missing or malformed');
  }
  // 1. identity, 2. agent-wallet
  if (Number(message.chainId) !== identity.chainId || !same(message.registry, identity.registry) || String(message.agentId) !== identity.agentId) return fail('identity', 'it names another identity');
  if (!identity.agentWallet || !same(message.agentWallet, identity.agentWallet)) return fail('agent-wallet', 'it was signed for another agent wallet (rotated since?)');
  // 3. wallet-set-at: the latest setting event at or before B must be the one in block walletSetAt. Reading from
  // walletSetAt on finds that event and any later one; none at all means the latest setting is earlier.
  let ev;
  try { ev = walletEvent ? await walletEvent(identity, Number(message.walletSetAt)) : undefined; } catch { ev = undefined; }
  if (ev === undefined) return { notRead: 'wallet-event', reason: 'could not read the agent wallet\'s setting events (MetadataSet)' };
  if (ev === null) return fail('wallet-set-at', `no agent wallet setting in block ${message.walletSetAt}: the wallet was set earlier`);
  const value = decodeWalletValue(ev.data);
  if (!value || !same(value, identity.agentWallet)) return { notRead: 'wallet-event', reason: 'the latest MetadataSet event does not carry the agent wallet getAgentWallet returns' };
  if (BigInt(ev.block) !== message.walletSetAt) return fail('wallet-set-at', `signed under the setting of block ${message.walletSetAt}; the agent wallet was set again in block ${ev.block}`);
  // 4. window
  const t = BigInt(Math.floor(now / 1000));
  if (message.validUntil <= message.validAfter) return fail('window', 'validUntil is not after validAfter');
  if (message.validUntil - message.validAfter > BigInt(MAX_VALIDITY_S)) return fail('window', 'valid for more than 90 days');
  if (t < message.validAfter) return fail('window', 'not valid yet');
  if (t >= message.validUntil) return fail('window', 'expired');
  // 5.-8.
  if (message.network !== String(accept.network) && message.network !== caipOf(accept.network)) return fail('network', `it is for network ${message.network}`);
  if (!same(message.payTo, accept.payTo)) return fail('pay-to', 'it names another payTo');
  if (message.asset !== '*' && !same(message.asset, accept.asset)) return fail('asset', 'it names another asset');
  if (message.origin !== '*' && originOf(message.origin) !== origin) return fail('origin', `it is for origin ${message.origin}`);
  // 9. not-declared: the network and payTo appear together in the registration file's payees list.
  if (!declares(identity.doc, String(accept.network), accept.payTo)) return fail('not-declared', 'the payee is not listed under payees in the registration file');
  // 10. signature: ECDSA for a wallet without contract code (an EIP-7702 indicator counts as none), ERC-1271 otherwise.
  const domain = { name: 'x402 Payee Delegation', version: DOMAIN_VERSION, chainId: identity.chainId, verifyingContract: identity.registry };
  const typed = { domain, types: DELEGATION_TYPES, primaryType: 'PayeeDelegation', message };
  if (isEoaCode(identity.walletCode)) {
    let recovered = null;
    try { recovered = await recoverTypedDataAddress({ ...typed, signature: sig }); } catch { recovered = null; }
    return recovered && same(recovered, identity.agentWallet) ? null : fail('signature', 'the signature is not the agent wallet\'s');
  }
  const digest = hashTypedData(typed).slice(2);
  const s = word(sig), len = s.length / 2;
  const data = `${SEL.isValidSignature}${digest}${hex64(64)}${hex64(len)}${s.padEnd(Math.ceil(s.length / 64) * 64, '0')}`;
  let res;
  try { res = await rpc(identity.network, 'eth_call', [{ to: identity.agentWallet, data }, `0x${identity.block.toString(16)}`]); } catch { return { notRead: 'signature', reason: 'could not call the agent wallet\'s isValidSignature (ERC-1271)' }; }
  return word(res).slice(0, 8).toLowerCase() === ERC1271_MAGIC.slice(2) ? null : fail('signature', 'the signature is not the agent wallet\'s (ERC-1271)');
}

// Section 4 for each payment requirement. `fileIdentities`: identities from the seller's own
// /.well-known/agent-registration.json whose registry points back to the domain, with that file as `doc`.
// Returns [{ network, payTo, asset, outcome, reason?, identity }] for the requirements, plus the identities read.
async function verifyPayees(accepts, { url, fileIdentities = [], rpc, fetchDoc, walletEvent, now = Date.now() }) {
  const cache = new Map();
  const read = (id, doc) => {
    const key = `${id.chainId}:${id.registry.toLowerCase()}:${id.agentId}`;
    if (!cache.has(key)) cache.set(key, readIdentity(id, { rpc, fetchDoc, doc }));
    return cache.get(key);
  };
  const results = [];
  for (const accept of (accepts || []).filter((a) => a && typeof a.payTo === 'string' && a.payTo)) {
    const origin = originOf(accept.resource) || originOf(url);
    const named = namedIdentity(accept);
    const fromFile = named ? fileIdentities.find((f) => f.chainId === named.chainId && same(f.registry, named.registry) && f.agentId === named.agentId) : fileIdentities[0];
    const target = named || fromFile;
    const base = { network: String(accept.network), payTo: accept.payTo, asset: accept.asset ?? null, delegationRule: null, notRead: null, notes: [] };
    const net = caipOf(accept.network);
    if (!target) { results.push({ ...base, outcome: 'no-identity' }); continue; }
    const identity = await read(target, fromFile?.doc ?? null);
    const who = { registry: `eip155:${identity.chainId}:${identity.registry}`, agentId: identity.agentId, block: identity.block, agentWallet: identity.agentWallet };
    if (identity.notRead) { results.push({ ...base, outcome: 'not-read', notRead: identity.notReadKind || 'registry', reason: `could not read the ${identity.notRead}`, identity: who }); continue; }
    // Section 6: a payees list that does not name this network and payTo is noted, whatever the outcome.
    if (hasPayeesList(identity.doc) && !declares(identity.doc, String(accept.network), accept.payTo)) base.notes = ['payee-not-declared'];
    if (!origin || !endpointOrigins(identity.doc).has(origin)) { results.push({ ...base, outcome: 'endpoint-unlisted', reason: `${origin || 'the resource'} is not an endpoint in agent #${identity.agentId}'s registration file`, identity: who }); continue; }
    if (!identity.agentWallet) {
      // owner-only: payTo is the identity's owner on the registry's chain. Reported, never verified.
      const ownerOnly = net === identity.network && identity.owner && same(accept.payTo, identity.owner);
      results.push({ ...base, outcome: ownerOnly ? 'owner-only' : 'no-agent-wallet', ...(ownerOnly ? { reason: 'payTo is the identity\'s owner, not a registered agent wallet' } : {}), identity: who });
      continue;
    }
    if (net.startsWith('eip155:') && same(accept.payTo, identity.agentWallet)
      && (net === identity.network || isEoaCode(identity.walletCode))) {
      results.push({ ...base, outcome: 'verified-wallet', identity: who });
      continue;
    }
    // One payTo can take several assets (USDC and $AFUEL on the same Solana wallet), each with its own delegation:
    // use the one for this option's asset (or "*"), else the first, which then says it names another asset.
    const declared = declaredPayees(identity.doc).filter((p) => (p.network === String(accept.network) || p.network === net) && same(p.payTo, accept.payTo) && p.delegation);
    const delegation = accept.extra?.erc8004?.delegation
      || (declared.find((p) => p.delegation.message?.asset === '*' || same(p.delegation.message?.asset, accept.asset)) || declared[0])?.delegation;
    if (!delegation) { results.push({ ...base, outcome: 'mismatch', reason: 'payTo is neither the agent wallet nor covered by a payee delegation', identity: who }); continue; }
    let problem;
    try { problem = await delegationProblem(delegation, { identity, accept, origin, now, rpc, walletEvent }); } catch { results.push({ ...base, outcome: 'not-read', notRead: 'signature', reason: 'could not check the delegation', identity: who }); continue; }
    if (problem?.notRead) { results.push({ ...base, outcome: 'not-read', notRead: problem.notRead, reason: problem.reason, identity: who }); continue; }
    results.push(problem ? { ...base, outcome: 'invalid-delegation', delegationRule: problem.rule, reason: problem.reason, identity: who } : { ...base, outcome: 'verified-delegation', identity: who });
  }
  return results;
}

module.exports = { caipOf, verifyPayees, delegationProblem, DELEGATION_TYPES, DOMAIN_VERSION, MAX_VALIDITY_S, RULES, METADATA_SET_TOPIC, AGENT_WALLET_KEY_TOPIC, decodeWalletValue, OUTCOMES, originOf, endpointOrigins, declaredPayees, isEoaCode, docUrl };
