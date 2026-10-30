'use strict';

// x402 payee verification for ERC-8004 agents (draft ERC, ethereum/ERCs#2132, 30 Oct 2026): is the payTo of a payment
// requirement bound to the ERC-8004 identity the payer means to pay? Bound means the resource's origin is listed in
// the identity's registration file, and the payTo is the agent wallet (getAgentWallet) or is covered by an EIP-712
// payee delegation the agent wallet signed. One outcome per requirement, never a score:
//   verified-wallet, verified-delegation, mismatch, invalid-delegation, endpoint-unlisted, no-agent-wallet,
//   no-identity, not-read (a failed read is never a pass or a fail).
// Read-only: eth_call / eth_getCode on the registry's chain and one fetch of the registration file.

const { recoverTypedDataAddress, hashTypedData } = require('viem');

const OUTCOMES = ['verified-wallet', 'verified-delegation', 'mismatch', 'invalid-delegation', 'endpoint-unlisted', 'no-agent-wallet', 'no-identity', 'not-read'];
const DELEGATION_TYPES = {
  PayeeDelegation: [
    { name: 'chainId', type: 'uint256' },
    { name: 'registry', type: 'address' },
    { name: 'agentId', type: 'uint256' },
    { name: 'agentWallet', type: 'address' },
    { name: 'network', type: 'string' },
    { name: 'payTo', type: 'string' },
    { name: 'asset', type: 'string' },
    { name: 'origin', type: 'string' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
const MAX_VALIDITY_S = 31_536_000; // 365 days
const SEL = { tokenURI: '0xc87b56dd', getAgentWallet: '0x00339509', isValidSignature: '0x1626ba7e' };
const ERC1271_MAGIC = '0x1626ba7e';

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

// Reads one identity at the latest block: agent wallet, its code, the registration file (unless given) and block.
// Any failed read leaves `notRead` naming it.
async function readIdentity(id, { rpc, fetchDoc, doc = null }) {
  const network = `eip155:${id.chainId}`;
  const out = { ...id, network, block: null, agentWallet: null, walletCode: null, doc, notRead: null };
  try {
    out.block = parseInt(await rpc(network, 'eth_blockNumber', []), 16);
    const tag = `0x${out.block.toString(16)}`;
    out.agentWallet = addrFromWord(await rpc(network, 'eth_call', [{ to: id.registry, data: `${SEL.getAgentWallet}${hex64(id.agentId)}` }, tag]));
    if (out.agentWallet && /^0x0{40}$/.test(out.agentWallet)) out.agentWallet = null;
    if (out.agentWallet) out.walletCode = await rpc(network, 'eth_getCode', [out.agentWallet, tag]);
    if (!out.doc) {
      const uri = decodeAbiString(await rpc(network, 'eth_call', [{ to: id.registry, data: `${SEL.tokenURI}${hex64(id.agentId)}` }, tag]));
      out.doc = uri ? await fetchDoc(uri) : null;
      if (!out.doc) out.notRead = 'registration file';
    }
  } catch (err) {
    out.notRead = out.block === null ? 'registry (block)' : out.agentWallet === null && out.walletCode === null ? 'registry (agent wallet)' : 'agent wallet code';
    out.error = String(err?.message || err).slice(0, 160);
  }
  return out;
}

// Section 3: is `delegation` ({ message, signature }) valid for this requirement? Returns null when valid, else the
// rule it fails.
async function delegationProblem(delegation, { identity, accept, origin, now, rpc }) {
  const m = delegation?.message, sig = delegation?.signature;
  if (!m || typeof m !== 'object' || typeof sig !== 'string' || !/^0x[0-9a-fA-F]+$/.test(sig)) return 'not a { message, signature } delegation';
  let message;
  try {
    message = {
      chainId: BigInt(m.chainId), registry: m.registry, agentId: BigInt(m.agentId), agentWallet: m.agentWallet,
      network: String(m.network), payTo: String(m.payTo), asset: String(m.asset), origin: String(m.origin),
      validAfter: BigInt(m.validAfter), validUntil: BigInt(m.validUntil), nonce: m.nonce,
    };
    if (!isHexAddr(message.registry) || !isHexAddr(message.agentWallet) || !/^0x[0-9a-fA-F]{64}$/.test(String(message.nonce))) throw new Error('fields');
  } catch {
    return 'a field is missing or malformed';
  }
  if (Number(message.chainId) !== identity.chainId || !same(message.registry, identity.registry) || String(message.agentId) !== identity.agentId) return 'it names another identity';
  if (!identity.agentWallet || !same(message.agentWallet, identity.agentWallet)) return 'it was signed for another agent wallet (rotated since?)';
  const t = BigInt(Math.floor(now / 1000));
  if (message.validUntil <= message.validAfter) return 'validUntil is not after validAfter';
  if (message.validUntil - message.validAfter > BigInt(MAX_VALIDITY_S)) return 'valid for more than 365 days';
  if (t < message.validAfter) return 'not valid yet';
  if (t >= message.validUntil) return 'expired';
  if (message.network !== String(accept.network)) return `it is for network ${message.network}`;
  if (!same(message.payTo, accept.payTo)) return 'it names another payTo';
  if (message.asset !== '*' && !same(message.asset, accept.asset)) return 'it names another asset';
  if (message.origin !== '*' && originOf(message.origin) !== origin) return `it is for origin ${message.origin}`;
  const domain = { name: 'x402 Payee Delegation', version: '1', chainId: identity.chainId, verifyingContract: identity.registry };
  const typed = { domain, types: DELEGATION_TYPES, primaryType: 'PayeeDelegation', message };
  let recovered = null;
  try { recovered = await recoverTypedDataAddress({ ...typed, signature: sig }); } catch { recovered = null; }
  if (recovered && same(recovered, identity.agentWallet)) return null;
  if (isEoaCode(identity.walletCode) && word(identity.walletCode) === '') return 'the signature is not the agent wallet\'s';
  // A contract (or 7702-delegated) agent wallet: ERC-1271 on the registry's chain.
  const digest = hashTypedData(typed).slice(2);
  const s = word(sig), len = s.length / 2;
  const data = `${SEL.isValidSignature}${digest}${hex64(64)}${hex64(len)}${s.padEnd(Math.ceil(s.length / 64) * 64, '0')}`;
  const res = await rpc(identity.network, 'eth_call', [{ to: identity.agentWallet, data }, `0x${identity.block.toString(16)}`]);
  return word(res).slice(0, 8).toLowerCase() === ERC1271_MAGIC.slice(2) ? null : 'the signature is not the agent wallet\'s (ECDSA nor ERC-1271)';
}

// Section 4 for each payment requirement. `fileIdentities`: identities from the seller's own
// /.well-known/agent-registration.json whose registry points back to the domain, with that file as `doc`.
// Returns [{ network, payTo, asset, outcome, reason?, identity }] for the requirements, plus the identities read.
async function verifyPayees(accepts, { url, fileIdentities = [], rpc, fetchDoc, now = Date.now() }) {
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
    const base = { network: String(accept.network), payTo: accept.payTo, asset: accept.asset ?? null };
    if (!target) { results.push({ ...base, outcome: 'no-identity' }); continue; }
    const identity = await read(target, fromFile?.doc ?? null);
    const who = { registry: `eip155:${identity.chainId}:${identity.registry}`, agentId: identity.agentId, block: identity.block, agentWallet: identity.agentWallet };
    if (identity.notRead) { results.push({ ...base, outcome: 'not-read', reason: `could not read the ${identity.notRead}`, identity: who }); continue; }
    if (!origin || !endpointOrigins(identity.doc).has(origin)) { results.push({ ...base, outcome: 'endpoint-unlisted', reason: `${origin || 'the resource'} is not an endpoint in agent #${identity.agentId}'s registration file`, identity: who }); continue; }
    if (!identity.agentWallet) { results.push({ ...base, outcome: 'no-agent-wallet', identity: who }); continue; }
    if (String(accept.network).startsWith('eip155:') && same(accept.payTo, identity.agentWallet)
      && (accept.network === identity.network || isEoaCode(identity.walletCode))) {
      results.push({ ...base, outcome: 'verified-wallet', identity: who });
      continue;
    }
    const delegation = accept.extra?.erc8004?.delegation
      || declaredPayees(identity.doc).find((p) => p.network === String(accept.network) && same(p.payTo, accept.payTo) && p.delegation)?.delegation;
    if (!delegation) { results.push({ ...base, outcome: 'mismatch', reason: 'payTo is neither the agent wallet nor covered by a payee delegation', identity: who }); continue; }
    let problem;
    try { problem = await delegationProblem(delegation, { identity, accept, origin, now, rpc }); } catch { results.push({ ...base, outcome: 'not-read', reason: 'could not check the delegation\'s ERC-1271 signature', identity: who }); continue; }
    results.push(problem ? { ...base, outcome: 'invalid-delegation', reason: problem, identity: who } : { ...base, outcome: 'verified-delegation', identity: who });
  }
  return results;
}

module.exports = { verifyPayees, delegationProblem, DELEGATION_TYPES, OUTCOMES, originOf, endpointOrigins, declaredPayees, isEoaCode, docUrl };
