'use strict';

// The payer's key for a cross-network buyer proof (the Concordium facilitator's binding "payer-key"): an agent pays on
// Base or Solana, and its owner shows not only that they vouch for the paying address but that they control it,
// because they bound that address's key to their Concordium account in the CIS-8 External Key Registry.
//
// /concordium-proof.html (role "other") asks POST /api/v1/concordium/payer-key before it writes the file:
//   Solana: the key is the address itself (ed25519);
//   EVM:    an address is a hash of its key, so the owner signs a short message with the paying wallet and the key is
//           recovered from that signature (the recovered key must be the address's key).
// Then the registry is asked whether it holds an active binding of that key (owner_of_key), and to which account.
//   Algorand, Stellar: the address is the key too (ed25519; lib/concordium-ed25519-key.js reads it).
// Read-only: nothing is signed or paid by us, and the signature only shows which key is the address's.
const { recoverPublicKey, hashMessage } = require('viem');
const { publicKeyToAddress } = require('viem/accounts');
const { base58Decode } = require('./networks');
const { registryCall } = require('./concordium-agent');

const NETWORK_IDS = new Set(['testnet', 'mainnet']);
const CAIP2 = /^(?:[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}|algorand:[A-Za-z0-9+/]{43}=)$/; // x402's Algorand id: the genesis hash
const { ed25519KeyOf, namespacesFor } = require('./concordium-ed25519-key');
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// The message the paying wallet signs: names the purpose and the address, so a signature can't be taken for another.
const keyMessage = (payerNetwork, address) => `Concordium CIS-8 key check for an x402 buyer proof\nPaying address: ${address}\nNetwork: ${payerNetwork}\n\nThis signature only shows which public key belongs to this address. It moves no funds.`;

// -> { key: { namespace, key_type, public_key_hex } } or { error }
async function keyOf({ payerNetwork, address, signature }) {
  if (!CAIP2.test(String(payerNetwork || ''))) return { error: 'payerNetwork: a CAIP-2 network id (eip155:8453, solana:…)' };
  if (payerNetwork.startsWith('solana:')) {
    const bytes = base58Decode(String(address || ''));
    if (!bytes || bytes.length !== 32) return { error: 'address: a Solana address' };
    return { key: { namespace: payerNetwork, key_type: 'ed25519', public_key_hex: Buffer.from(bytes).toString('hex') } };
  }
  if (payerNetwork.startsWith('eip155:')) {
    if (!EVM_ADDRESS.test(String(address || ''))) return { error: 'address: an EVM address (0x…)' };
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(signature || ''))) return { error: 'signature: the paying wallet\'s signature of the key-check message (personal_sign)' };
    let pub;
    try { pub = await recoverPublicKey({ hash: hashMessage(keyMessage(payerNetwork, address)), signature }); } catch { return { error: 'the signature could not be read' }; }
    if (publicKeyToAddress(pub).toLowerCase() !== address.toLowerCase()) return { error: 'the signature is not from this address (sign with the wallet the agent pays from)' };
    // Recovered as 0x04‖X‖Y: kept as X‖Y; the 04 is added again for the registry.
    return { key: { namespace: payerNetwork, key_type: 'secp256k1-uncompressed', public_key_hex: pub.slice(4).toLowerCase() } };
  }
  if (payerNetwork.startsWith('algorand:') || payerNetwork.startsWith('stellar:')) {
    const hex = ed25519KeyOf(payerNetwork, address);
    if (!hex) return { error: payerNetwork.startsWith('stellar:') ? 'address: a Stellar account (G…)' : 'address: an Algorand address' };
    return { key: { namespace: namespacesFor(payerNetwork)[0], key_type: 'ed25519', public_key_hex: hex } };
  }
  return { error: 'only EVM (eip155), Solana, Algorand and Stellar addresses for now' };
}

// The whole answer: the key, and whether the CIS-8 registry binds it (bound true/false, or null when unreadable).
async function payerKey({ network, payerNetwork, address, signature }, { call = registryCall } = {}) {
  if (!NETWORK_IDS.has(network)) return { status: 400, body: { error: 'network: testnet or mainnet (the Concordium network of the proof)' } };
  const k = await keyOf({ payerNetwork, address, signature });
  if (k.error) return { status: 400, body: { error: k.error } };
  // A binding names a namespace: the chain the owner registered the key for. Try the paying network first, then the
  // family's usual ones (an EVM key is one key on every EVM chain). The registry keeps uncompressed keys with 04.
  const family = payerNetwork.split(':')[0];
  // Algorand and Stellar: Concordium's own namespace (algorand:mainnet, stellar:pubnet) first, then the x402 id.
  const namespaces = family === 'algorand' || family === 'stellar' ? namespacesFor(payerNetwork)
    : [...new Set([payerNetwork, ...(family === 'eip155' ? ['eip155:1', 'eip155:8453', 'eip155'] : [family])])];
  const hexFor = (key) => (key.key_type === 'secp256k1-uncompressed' ? `04${key.public_key_hex}` : key.public_key_hex);
  let unreadable = null;
  for (const namespace of namespaces) {
    const key = { ...k.key, namespace };
    let reg;
    try { reg = await call('owner_of_key', { external_key: { ...key, public_key_hex: hexFor(key) }, network }); } catch (err) { unreadable = String(err?.message || err).slice(0, 80); continue; }
    const owner = reg ? (reg.owner_account || reg.owner || reg.account || null) : null;
    if (reg && owner && (!reg.status || reg.status === 'Active')) return { status: 200, body: { key, bound: true, account: owner } };
  }
  if (unreadable) return { status: 200, body: { key: k.key, bound: null, reason: `the CIS-8 registry could not be read (${unreadable})` } };
  return { status: 200, body: { key: k.key, bound: false, reason: 'the CIS-8 registry holds no active binding of this key: bind it to your Concordium account first (Concordium\'s Agent Registry app), then the proof can show control' } };
}

module.exports = { payerKey, keyOf, keyMessage };
