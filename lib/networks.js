// Known x402 networks and their USDC, plus address helpers.

const NETWORKS = {
  'eip155:8453': { name: 'Base', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', testnet: false, family: 'evm', rpc: 'https://mainnet.base.org' },
  'eip155:84532': { name: 'Base Sepolia', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', testnet: true, family: 'evm' },
  'eip155:137': { name: 'Polygon', usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', testnet: false, family: 'evm', rpc: 'https://polygon-rpc.com' },
  'eip155:80002': { name: 'Polygon Amoy', usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', testnet: true, family: 'evm' },
  'eip155:42161': { name: 'Arbitrum', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', testnet: false, family: 'evm', rpc: 'https://arb1.arbitrum.io/rpc' },
  'eip155:43114': { name: 'Avalanche', usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', testnet: false, family: 'evm', rpc: 'https://api.avax.network/ext/bc/C/rpc' },
  'eip155:43113': { name: 'Avalanche Fuji', usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', testnet: true, family: 'evm' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { name: 'Solana', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', testnet: false, family: 'solana' },
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': { name: 'Solana Devnet', usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', testnet: true, family: 'solana' },
  // XRP Ledger: payTo is a classic r-address, asset a currency code (e.g. RLUSD), amounts are decimals.
  'xrpl:0': { name: 'XRP Ledger', testnet: false, family: 'xrpl' },
  'xrpl:1': { name: 'XRPL Testnet', testnet: true, family: 'xrpl' },
};

// v1 used plain names; v2 requires CAIP-2 ids.
const V1_NAMES = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  arbitrum: 'eip155:42161',
  avalanche: 'eip155:43114',
  'avalanche-fuji': 'eip155:43113',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'solana:mainnet': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana:devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
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
// XRPL classic address (r…, base58) and currency code (3 characters, or 40 hex for longer codes like RLUSD).
const isXrplAddress = (value) => typeof value === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value);
const isXrplCurrency = (value) => typeof value === 'string' && (/^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(value) || /^[A-Fa-f0-9]{40}$/.test(value));

function familyOf(network) {
  if (NETWORKS[network]) return NETWORKS[network].family;
  if (String(network).startsWith('solana')) return 'solana';
  if (String(network).startsWith('eip155:')) return 'evm';
  if (String(network).startsWith('xrpl:')) return 'xrpl';
  return null;
}

module.exports = { NETWORKS, V1_NAMES, CAIP2_RE, isSolanaAddress, isEvmAddress, isXrplAddress, isXrplCurrency, familyOf, base58Decode };
