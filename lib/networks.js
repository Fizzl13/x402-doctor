// Known x402 networks and their USDC, plus address helpers.

const NETWORKS = {
  'eip155:8453': { name: 'Base', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', testnet: false, family: 'evm', rpc: 'https://mainnet.base.org' },
  'eip155:84532': { name: 'Base Sepolia', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', testnet: true, family: 'evm' },
  'eip155:137': { name: 'Polygon', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', testnet: false, family: 'evm', rpc: 'https://polygon-rpc.com' },
  'eip155:80002': { name: 'Polygon Amoy', usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', testnet: true, family: 'evm' },
  'eip155:42161': { name: 'Arbitrum', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', testnet: false, family: 'evm', rpc: 'https://arb1.arbitrum.io/rpc' },
  'eip155:10': { name: 'Optimism', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', testnet: false, family: 'evm', rpc: 'https://mainnet.optimism.io' },
  'eip155:43114': { name: 'Avalanche', usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', testnet: false, family: 'evm', rpc: 'https://api.avax.network/ext/bc/C/rpc' },
  'eip155:43113': { name: 'Avalanche Fuji', usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', testnet: true, family: 'evm' },
  // More EVM chains with Circle's native USDC (addresses from developers.circle.com/stablecoins/usdc-contract-addresses).
  'eip155:1': { name: 'Ethereum', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', testnet: false, family: 'evm' },
  'eip155:480': { name: 'World Chain', usdc: '0x79A02482A880bCe3F13E09da970dC34dB4cD24D1', testnet: false, family: 'evm' },
  'eip155:143': { name: 'Monad', usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', testnet: false, family: 'evm' },
  'eip155:999': { name: 'HyperEVM', usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', testnet: false, family: 'evm' },
  'eip155:130': { name: 'Unichain', usdc: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', testnet: false, family: 'evm' },
  'eip155:1329': { name: 'Sei', usdc: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', testnet: false, family: 'evm' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { name: 'Solana', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', testnet: false, family: 'solana' },
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': { name: 'Solana Devnet', usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', testnet: true, family: 'solana' },
  // XRP Ledger: payTo is a classic r-address, asset a currency code (e.g. RLUSD), amounts are decimals.
  // An XRP option is priced in drops (integer, 1 XRP = 1,000,000 drops); an issued token like RLUSD in decimals,
  // with extra.issuer. A payout account must be activated (hold the XRP reserve) and, for a token, have a trust
  // line to its issuer before it can receive it. rlusd: Ripple's RLUSD on that ledger.
  'xrpl:0': { name: 'XRP Ledger', testnet: false, family: 'xrpl', rpc: 'https://xrplcluster.com', rlusd: { currency: '524C555344000000000000000000000000000000', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' } },
  'xrpl:1': { name: 'XRPL Testnet', testnet: true, family: 'xrpl', rpc: 'https://testnet.xrpl-labs.com', rlusd: { currency: '524C555344000000000000000000000000000000', issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' } },
  // Algorand (x402 "exact" on the AVM, GoPlausible facilitator): the id is the genesis hash, payTo a 58-character
  // address, asset an ASA id (USDC is ASA 31566704), amounts atomic like EVM. A payout address must opt in to an
  // ASA before it can receive it.
  'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=': { name: 'Algorand', usdc: '31566704', testnet: false, family: 'algorand', algod: 'https://mainnet-api.algonode.cloud' },
  'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=': { name: 'Algorand Testnet', usdc: '10458941', testnet: true, family: 'algorand', algod: 'https://testnet-api.algonode.cloud' },
};
// CAIP-2 caps a chain reference at 32 characters, so the Algorand namespace uses the first 32 characters of the
// genesis hash. Sellers use both forms (on 6 Oct 2026 the short one ~4x as often): both are the same network.
// Bitcoin Lightning (x402 exact on lnbtc, Sept 2026): BIP-122 style references, BOLT11 currency prefix.
NETWORKS['lnbtc:000000000019d6689c085ae165831e93'] = { name: 'Bitcoin Lightning', testnet: false, family: 'lightning', bolt11: 'bc' };
NETWORKS['lnbtc:000000000933ea01ad0ee984209779ba'] = { name: 'Bitcoin Lightning Testnet', testnet: true, family: 'lightning', bolt11: 'tb' };
NETWORKS['algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k'] = NETWORKS['algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='];
NETWORKS['algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe'] = NETWORKS['algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='];

// v1 used plain names; v2 requires CAIP-2 ids.
const V1_NAMES = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  arbitrum: 'eip155:42161',
  optimism: 'eip155:10',
  avalanche: 'eip155:43114',
  'avalanche-fuji': 'eip155:43113',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'solana:mainnet': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana:devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  algorand: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  'algorand-mainnet': 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  'algorand-testnet': 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
};

const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
// A network a caller may name: CAIP-2, or x402's Algorand id, whose reference is the base64 genesis hash
// (44 characters, with + / =), longer than CAIP-2 allows.
const NETWORK_ID_RE = /^(?:[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}|algorand:[A-Za-z0-9+/]{43}=)$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(value) {
  let n = 0n;
  for (const char of String(value)) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const char of String(value)) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const isSolanaAddress = (value) => typeof value === 'string' && base58Decode(value)?.length === 32;
const isEvmAddress = (value) => typeof value === 'string' && EVM_ADDRESS_RE.test(value);
// XRPL classic address: r…, in the XRPL's own base58 alphabet, 25 bytes = type 0x00 + 20-byte account id + the first
// 4 bytes of a double SHA-256 as a checksum. Currency code: 3 characters, or 40 hex for longer codes like RLUSD.
const XRPL_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function isXrplAddress(value) {
  if (typeof value !== 'string' || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return false;
  let n = 0n;
  for (const ch of value) {
    const d = XRPL_ALPHABET.indexOf(ch);
    if (d < 0) return false;
    n = n * 58n + BigInt(d);
  }
  const hex = n.toString(16).padStart(50, '0');
  if (hex.length !== 50) return false;
  const bytes = Buffer.from(hex, 'hex'); // the leading "r" is the 0x00 type byte
  const { createHash } = require('node:crypto');
  const sum = createHash('sha256').update(createHash('sha256').update(bytes.subarray(0, 21)).digest()).digest();
  return bytes[0] === 0 && sum.subarray(0, 4).equals(bytes.subarray(21, 25));
}
// Algorand address: 58 base32 characters = 32-byte public key + the last 4 bytes of its SHA-512/256 as a checksum.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function isAlgorandAddress(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]{58}$/.test(value)) return false;
  let bits = 0, acc = 0;
  const bytes = [];
  for (const ch of value) {
    acc = (acc << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
  }
  if (bytes.length < 36) return false;
  const key = Buffer.from(bytes.slice(0, 32));
  const sum = require('node:crypto').createHash('sha512-256').update(key).digest().subarray(28, 32);
  return Buffer.from(bytes.slice(32, 36)).equals(sum);
}
// An Algorand Standard Asset id: a positive integer, as a string.
const isAsaId = (value) => /^[1-9]\d{0,19}$/.test(String(value ?? ''));
const isXrplCurrency = (value) => typeof value === 'string' && (/^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(value) || /^[A-Fa-f0-9]{40}$/.test(value));

function familyOf(network) {
  if (NETWORKS[network]) return NETWORKS[network].family;
  if (String(network).startsWith('solana')) return 'solana';
  if (String(network).startsWith('eip155:')) return 'evm';
  if (String(network).startsWith('xrpl:')) return 'xrpl';
  if (String(network).startsWith('algorand:')) return 'algorand';
  if (String(network).startsWith('lnbtc:')) return 'lightning';
  return null;
}

// EVM addresses are case-insensitive (checksum casing is optional); Solana mints are exact.
function sameAsset(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return /^0x/i.test(a) && /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

module.exports = { sameAsset, NETWORKS, V1_NAMES, CAIP2_RE, NETWORK_ID_RE, isSolanaAddress, isEvmAddress, isXrplAddress, isXrplCurrency, isAlgorandAddress, isAsaId, familyOf, base58Decode };
