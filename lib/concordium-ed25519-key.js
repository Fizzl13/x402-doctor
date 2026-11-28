'use strict';

// A seller's payTo on an ed25519 chain (Algorand, Stellar, Solana) bound to its Concordium account with CIS-8, the
// External Key Registry (mainnet <10081,0>). Concordium lists Algorand and Stellar as tier 2: the contract checks a raw
// ed25519 signature over its canonical bytes, and browser wallets on those chains only sign wrapped messages (a prefix,
// a hash), which the contract does not accept yet. So the owner signs the bytes on their own computer with
// /concordium/cis8-sign.mjs, pastes the signature, and their Concordium wallet sends registerExternalKey.
//
// On these chains the address is the public key (Algorand: base32 + checksum; Stellar: a G… StrKey; Solana: base58), so
// anyone can read the key from a payTo and ask the registry who controls it. Doctor's payee check does that: a payTo
// whose key CIS-8 binds to the agent's owner is the owner's (lib/concordium-agent.js).
//
// bindStep({ network, account, payNetwork, payTo, signature? }):
//   without a signature: the key, the canonical bytes to sign and the command;
//   with one:            the signature checked here (ed25519), then the registerExternalKey transaction built.
// Read-only: nothing is signed or sent by us. We never see a secret key.
const crypto = require('node:crypto');
const { isAlgorandAddress, isStellarAddress, base58Decode, isSolanaAddress } = require('./networks');
const { registryCall } = require('./concordium-agent');

const NETWORK_IDS = new Set(['testnet', 'mainnet']);
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SCHEME = 'solana-ed25519'; // Concordium's scheme for a raw ed25519 signature (chains.json: tier 2 uses it too)

function base32Bytes(s) {
  let bits = 0, acc = 0;
  const out = [];
  for (const ch of s) {
    acc = ((acc << 5) | BASE32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return Buffer.from(out);
}
function base32String(bytes) {
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += BASE32[(acc >> bits) & 31]; }
  }
  if (bits) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}
function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// The chain family of an x402 network id or a CIS-8 namespace, and whether it is a testnet.
function familyOf(network) {
  const n = String(network || '');
  if (n.startsWith('algorand:')) return { family: 'algorand', testnet: /testnet|SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe/.test(n) };
  if (n.startsWith('stellar:')) return { family: 'stellar', testnet: n === 'stellar:testnet' };
  if (n.startsWith('solana:')) return { family: 'solana', testnet: !n.startsWith('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') };
  return null;
}
// The namespaces a binding of this chain's key may carry: Concordium's own (chains.json: algorand:mainnet,
// stellar:pubnet, solana:<genesis>), then the x402 network id itself.
function namespacesFor(network) {
  const f = familyOf(network);
  if (!f) return [];
  const own = {
    algorand: f.testnet ? 'algorand:testnet' : 'algorand:mainnet',
    stellar: f.testnet ? 'stellar:testnet' : 'stellar:pubnet',
    solana: f.testnet ? 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' : 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  }[f.family];
  return [...new Set([own, String(network)])];
}

// payTo -> its 32-byte ed25519 public key as hex, or null (not an address of an ed25519 account on that chain).
function ed25519KeyOf(network, payTo) {
  const f = familyOf(network);
  const s = String(payTo || '');
  if (f?.family === 'algorand' && isAlgorandAddress(s)) return base32Bytes(s).subarray(0, 32).toString('hex');
  if (f?.family === 'stellar' && isStellarAddress(s, 'G')) return base32Bytes(s).subarray(1, 33).toString('hex');
  if (f?.family === 'solana' && isSolanaAddress(s)) {
    const b = base58Decode(s);
    return b && b.length === 32 ? Buffer.from(b).toString('hex') : null;
  }
  return null;
}
// The other way: a key -> its address on that chain (for showing a bound key as the payTo it is).
function addressOfEd25519(network, hex) {
  const f = familyOf(network);
  if (!f || !/^[0-9a-f]{64}$/i.test(String(hex || ''))) return null;
  const key = Buffer.from(hex, 'hex');
  if (f.family === 'algorand') return base32String(Buffer.concat([key, crypto.createHash('sha512-256').update(key).digest().subarray(28, 32)]));
  if (f.family === 'stellar') {
    const body = Buffer.concat([Buffer.from([6 << 3]), key]);
    const crc = crc16xmodem(body);
    return base32String(Buffer.concat([body, Buffer.from([crc & 255, crc >> 8])]));
  }
  return null; // Solana: base58 of the key (lib/concordium-agent.js has the encoder)
}

// A raw ed25519 signature check with Node's own crypto (the key as SPKI DER: a fixed 12-byte prefix + the 32 bytes).
function verifyEd25519(keyHex, bytes, sigHex) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(keyHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, bytes, key, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

// Who CIS-8 says controls this payTo's key: { bound: true, account, namespace } | { bound: false } | { bound: null, reason }.
async function payToBinding(concordiumNetwork, network, payTo, { call = registryCall } = {}) {
  const hex = ed25519KeyOf(network, payTo);
  if (!hex) return { bound: false, reason: 'not an ed25519 address (Algorand, Stellar G…, Solana)' };
  let unreadable = null;
  for (const namespace of namespacesFor(network)) {
    let reg;
    try { reg = await call('owner_of_key', { external_key: { namespace, key_type: 'ed25519', public_key_hex: hex }, network: concordiumNetwork }); } catch (err) { unreadable = String(err?.message || err).slice(0, 80); continue; }
    const account = reg ? (reg.owner_account || reg.owner || reg.account || null) : null;
    if (reg && account && (!reg.status || reg.status === 'Active')) return { bound: true, account, namespace, key: { namespace, key_type: 'ed25519', public_key_hex: hex } };
  }
  return unreadable ? { bound: null, reason: `the CIS-8 registry could not be read (${unreadable})` } : { bound: false };
}

const ACCOUNT_RE = /^[1-9A-HJ-NP-Za-km-z]{50}$/;

async function bindStep({ network, account, payNetwork, payTo, signature } = {}, { call = registryCall } = {}) {
  if (!NETWORK_IDS.has(network)) return { status: 400, body: { error: 'network: testnet or mainnet (the Concordium network)' } };
  if (!ACCOUNT_RE.test(String(account || ''))) return { status: 400, body: { error: 'account: the Concordium account that will own the binding (the agent\'s owner)' } };
  const f = familyOf(payNetwork);
  if (!f || f.family === 'solana') return { status: 400, body: { error: 'payNetwork: an Algorand or Stellar network (x402 id or algorand:mainnet / stellar:pubnet). Solana wallets sign raw bytes: use Concordium\'s Agent Registry app for those.' } };
  if (f.testnet !== (network === 'testnet')) return { status: 400, body: { error: `a ${f.testnet ? 'testnet' : 'mainnet'} payTo binds on Concordium ${f.testnet ? 'testnet' : 'mainnet'}` } };
  const hex = ed25519KeyOf(payNetwork, payTo);
  if (!hex) return { status: 400, body: { error: f.family === 'stellar' ? 'payTo: a Stellar account (G…)' : 'payTo: an Algorand address (58 characters)' } };
  const namespace = namespacesFor(payNetwork)[0];
  const key = { namespace, key_type: 'ed25519', public_key_hex: hex };
  const already = await payToBinding(network, payNetwork, payTo, { call }).catch(() => null);
  if (already?.bound) return { status: 200, body: { key, bound: true, account: already.account, done: already.account === account } };
  let canon;
  try {
    canon = await call('build_cis8_canonical_bytes', { network, concordium_account: account, external_namespace: namespace, external_key_namespace: namespace, external_key_type: 'ed25519', external_public_key_hex: hex, proof_scheme: SCHEME });
  } catch (err) {
    return { status: 502, body: { error: `Concordium's registry service did not answer (${String(err?.message || err).slice(0, 80)})` } };
  }
  if (!/^[0-9a-f]+$/i.test(String(canon?.bytes_hex || ''))) return { status: 502, body: { error: 'Concordium\'s registry service returned no canonical bytes' } };
  const bytes = Buffer.from(canon.bytes_hex, 'hex');
  // The bytes name this account, the CIS-8 contract and the key: check before anyone signs them.
  if (!bytes.subarray(0, 18).equals(Buffer.from('CIS-8/v1/canonical')) || !bytes.includes(Buffer.from(hex, 'hex'))) return { status: 502, body: { error: 'the canonical bytes do not name this key' } };
  if (!signature) {
    return { status: 200, body: { key, bound: false, bytes_hex: canon.bytes_hex, scheme: SCHEME, sign: `node cis8-sign.mjs ${payTo} ${canon.bytes_hex}` } };
  }
  const sig = String(signature).replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sig)) return { status: 400, body: { error: 'signature: 64 bytes as hex (what cis8-sign.mjs prints)' } };
  if (!verifyEd25519(hex, bytes, sig)) return { status: 400, body: { error: `the signature is not ${payTo}'s over these bytes (signed for another account or network, or with another key)` } };
  let tx;
  try {
    tx = await call('build_cis8_register', { network, sender: account, external_key: key, proof: { scheme: SCHEME, signature_hex: sig } });
  } catch (err) {
    return { status: 502, body: { error: `Concordium's registry service did not build the transaction (${String(err?.message || err).slice(0, 80)})` } };
  }
  if (tx?.receive_name !== 'CIS-8.registerExternalKey' || !/^[0-9a-f]+$/i.test(String(tx?.parameter_hex || ''))) return { status: 502, body: { error: 'the registry service built no registerExternalKey' } };
  return { status: 200, body: { key, bound: false, signature_ok: true, tx: { contract_address: tx.contract_address, receive_name: tx.receive_name, parameter_json: tx.parameter_json, parameter_hex: tx.parameter_hex, suggested_energy: tx.suggested_energy || 30000, sender: account } } };
}

module.exports = { bindStep, payToBinding, ed25519KeyOf, addressOfEd25519, namespacesFor, familyOf, verifyEd25519, SCHEME };
