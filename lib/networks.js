const { blake2b } = require('./blake2b');
// Known x402 networks and their USDC (or other dollar stablecoins), plus address helpers.

const NETWORKS = {
  // Base also has Ripple's RLUSD (18 decimals, no EIP-3009: paid via Permit2; docs.ripple.com token addresses) and
  // Circle's euro stablecoin EURC (EIP-3009). Sellers offer both next to USDC (toll402.io, Oct 2026). Read on chain
  // on 29 Oct 2026: decimals, authorizationState and the EIP-712 domain DOMAIN_SEPARATOR hashes.
  'eip155:8453': {
    name: 'Base', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', testnet: false, family: 'evm', rpc: 'https://mainnet.base.org',
    stablecoins: {
      '0x8d58c0c60b8d6b88fa98b291a646db34d0f98258': { symbol: 'RLUSD', decimals: 18, eip3009: false, domain: { name: 'RLUSD', version: '1' } },
    },
    euroStablecoins: {
      '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': { symbol: 'EURC', decimals: 6, eip3009: true, domain: { name: 'EURC', version: '2' } },
    },
  },
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
  // HPP (House Party Protocol, an L2), in x402's own network list since Nov 2026 with bridged USDC. Read on chain on
  // 12 Nov 2026 (mainnet.hpp.io): chain id 190415, symbol USDC.e, 6 decimals, EIP-3009 (authorizationState answers),
  // and the DOMAIN_SEPARATOR hashes the domain "Bridged USDC" v2, not Base's "USD Coin": copied from Base, signatures fail.
  'eip155:190415': { name: 'HPP', usdc: '0x401eCb1D350407f13ba348573E5630B83638E30D', usdcSymbol: 'USDC.e', usdcDomain: { name: 'Bridged USDC', version: '2' }, testnet: false, family: 'evm', rpc: 'https://mainnet.hpp.io' },
  'eip155:181228': { name: 'HPP Sepolia', testnet: true, family: 'evm' },
  'eip155:999': { name: 'HyperEVM', usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', testnet: false, family: 'evm' },
  'eip155:130': { name: 'Unichain', usdc: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', testnet: false, family: 'evm' },
  'eip155:1329': { name: 'Sei', usdc: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', testnet: false, family: 'evm' },
  'eip155:146': { name: 'Sonic', usdc: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', testnet: false, family: 'evm' },
  // Arc, Circle's own chain (mainnet since 16 Sept 2026): USDC is the gas token, with an ERC-20 interface (6 decimals).
  'eip155:5042': { name: 'Arc', usdc: '0x3600000000000000000000000000000000000000', testnet: false, family: 'evm' },
  'eip155:5042002': { name: 'Arc Testnet', usdc: '0x3600000000000000000000000000000000000000', testnet: true, family: 'evm' },
  // The other testnets Circle Gateway serves (@circle-fin/x402-batching 3.5.0 lists them in its testnet 402s; Circle's
  // accept-agent-payments skill has new sellers start on testnet). USDC addresses as that 402 names them.
  'eip155:11155111': { name: 'Ethereum Sepolia', usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', testnet: true, family: 'evm' },
  'eip155:421614': { name: 'Arbitrum Sepolia', usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', testnet: true, family: 'evm' },
  'eip155:11155420': { name: 'Optimism Sepolia', usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', testnet: true, family: 'evm' },
  'eip155:1301': { name: 'Unichain Sepolia', usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F', testnet: true, family: 'evm' },
  'eip155:4801': { name: 'World Chain Sepolia', usdc: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88', testnet: true, family: 'evm' },
  'eip155:1328': { name: 'Sei Testnet', usdc: '0x4fCF1784B31630811181f670Aea7A7bEF803eaED', testnet: true, family: 'evm' },
  'eip155:998': { name: 'HyperEVM Testnet', usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab', testnet: true, family: 'evm' },
  'eip155:14601': { name: 'Sonic Testnet', usdc: '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51', testnet: true, family: 'evm' },
  // BNB Chain has no Circle-native USDC: x402 sellers price in 18-decimal dollar tokens, so "10000000000000000" is
  // $0.01. Binance-Peg USDC and USDT have no EIP-3009 (transferWithAuthorization) and are paid via Permit2, which
  // needs a one-time approval; USD1 and United Stables (U) have EIP-3009. Read on chain on 15 Oct 2026.
  'eip155:56': {
    name: 'BNB Chain', testnet: false, family: 'evm', rpc: 'https://bsc-dataseed.bnbchain.org',
    stablecoins: {
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18, eip3009: false },
      '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18, eip3009: false },
      '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': { symbol: 'USD1', decimals: 18, eip3009: true, domain: { name: 'World Liberty Financial USD', version: '1' } },
      '0xce24439f2d9c6a2289f741120fe202248b666666': { symbol: 'U', decimals: 18, eip3009: true, domain: { name: 'United Stables', version: '1' } },
    },
  },
  'eip155:97': { name: 'BNB Chain Testnet', testnet: true, family: 'evm' },
  // Three more chains x402 sellers list (on 21 Oct 2026 in about 2,700 Trust Index endpoints). Tokens as live 402s name
  // them, read on chain that day: 6 decimals, EIP-3009 (authorizationState answers) and the EIP-712 domain the
  // DOMAIN_SEPARATOR hashes. usdcDomain because USDC does not sign as "USD Coin" everywhere: on Celo it is "USDC".
  'eip155:196': {
    name: 'X Layer', usdc: '0x74b7f16337b8972027f6196a17a631ac6de26d22', usdcDomain: { name: 'USD Coin', version: '2' }, testnet: false, family: 'evm', rpc: 'https://rpc.xlayer.tech',
    stablecoins: {
      '0x779ded0c9e1022225f8e0630b35a9b54be713736': { symbol: 'USD₮0', decimals: 6, eip3009: true, domain: { name: 'USD₮0', version: '1' } },
    },
  },
  'eip155:42220': { name: 'Celo', usdc: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', usdcDomain: { name: 'USDC', version: '2' }, testnet: false, family: 'evm', rpc: 'https://forno.celo.org' },
  // Robinhood Chain: no USDC; sellers price in Paxos's Global Dollar.
  'eip155:4663': {
    name: 'Robinhood Chain', testnet: false, family: 'evm', rpc: 'https://rpc.mainnet.chain.robinhood.com',
    stablecoins: {
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6, eip3009: true, domain: { name: 'Global Dollar', version: '1' } },
    },
  },
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
  // Stellar (x402 "exact" with Soroban token transfers, @x402/stellar): payTo a G… account, C… contract or M… muxed
  // account, asset the token's C… contract (for USDC its Stellar Asset Contract), amounts atomic with 7 decimals
  // ("100000" is $0.01). The facilitator rebuilds and submits the transaction and pays its fee: clients require
  // extra.areFeesSponsored: true. A G… payout account needs a trustline to Circle's USDC to receive it.
  // Contracts read from Horizon on 17 Oct 2026 (the contract_id of USDC:<issuer>).
  'stellar:pubnet': { name: 'Stellar', usdc: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', usdcDecimals: 7, usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', testnet: false, family: 'stellar', horizon: 'https://horizon.stellar.org' },
  // Nano (x402 "exact" from @x402nano/exact; the network id proposed in x402-foundation/x402#3432): no token
  // contracts, the asset is the native coin XNO, amounts in raw (10^30 raw = 1 XNO), payTo a nano_… account. The seller
  // verifies the signed send block and broadcasts it itself: no facilitator, feeless.
  'nano:mainnet': { name: 'Nano', testnet: false, family: 'nano', native: { symbol: 'XNO', decimals: 30 } },
  'stellar:testnet': { name: 'Stellar Testnet', usdc: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', usdcDecimals: 7, usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', testnet: true, family: 'stellar', horizon: 'https://horizon-testnet.stellar.org' },
  // TRON (the TRON x402 SDK from BofAI): the network id is "tron:" + the chain id in decimal (mainnet 0x2b6653dc).
  // payTo and asset are base58 addresses (T…, 34 characters); no Circle USDC, the dollar tokens are Tether's USDT
  // (6 decimals) and USDD (18). Schemes: "exact" (extra.assetTransferMethod "eip3009" or "permit2"; USDT has no
  // EIP-3009, so it goes through Permit2), "upto", and two TRON-only ones: "exact_gasfree" (the buyer pays in USDT or
  // USDD without holding TRX; a relayer submits through the GasFree contract) and the older "exact_permit"
  // (TIP-712). Token contracts read from TronGrid on 6 Nov 2026; keys keep their case (base58 is case-sensitive).
  'tron:728126428': {
    name: 'TRON', testnet: false, family: 'tron',
    stablecoins: {
      TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: { symbol: 'USDT', decimals: 6, eip3009: false },
      TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz: { symbol: 'USDD', decimals: 18, eip3009: false },
      TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn: { symbol: 'USDD', decimals: 18, eip3009: false }, // the old USDD contract
    },
  },
  'tron:3448148188': { name: 'TRON Nile Testnet', testnet: true, family: 'tron', stablecoins: { TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf: { symbol: 'USDT', decimals: 6, eip3009: false } } },
  'tron:2494104990': { name: 'TRON Shasta Testnet', testnet: true, family: 'tron' },
};
// Concordium (ccd: + the first 32 hex characters of the genesis hash, as in Concordium's own CAIP-2 ids). No x402
// scheme or facilitator for Concordium exists yet (Nov 2026): x402 Doctor checks an option's shape (a Concordium
// account as payTo, CCD or a protocol-level token as asset, an atomic amount) and says nothing settles it yet.
// CCD has 6 decimals (1 CCD = 1,000,000 microCCD); a PLT has its own, which a seller can give as extra.decimals.
NETWORKS['ccd:9dd9ca4d19e9393877d2c44b70f89acb'] = { name: 'Concordium', testnet: false, family: 'concordium', native: { symbol: 'CCD', decimals: 6 } };
NETWORKS['ccd:4221332d34e1694168c2a0c0b3fd0f27'] = { name: 'Concordium Testnet', testnet: true, family: 'concordium', native: { symbol: 'CCD', decimals: 6 } };
// Other names sellers use for the TRON networks: the chain id in hex (r402) and plain names (t402). The same
// networks; the check notes that BofAI's clients look for the decimal id.
const TRON_ALIASES = { 'tron:0x2b6653dc': 'tron:728126428', 'tron:mainnet': 'tron:728126428', 'tron:0xcd8690dc': 'tron:3448148188', 'tron:nile': 'tron:3448148188', 'tron:0x94a9059e': 'tron:2494104990', 'tron:shasta': 'tron:2494104990' };
for (const [alias, id] of Object.entries(TRON_ALIASES)) NETWORKS[alias] = NETWORKS[id];
// Cardano (x402's exact scheme on Cardano: specs/schemes/exact/scheme_exact_cardano.md, @x402/cardano). The canonical
// ids are cardano:mainnet, cardano:preprod and cardano:preview; CIP-34's cip34:<NetworkId>-<NetworkMagic> forms are
// aliases a facilitator must treat as the same network. payTo is a Shelley address in bech32 (addr1… on mainnet,
// addr_test1… on the testnets), asset is "lovelace" (ADA, 6 decimals) or a native token as policyId.assetNameHex
// (USDM: the CIP-68 333 label and "USDM"). The buyer signs the whole transaction and pays its fee and the min-ADA
// that travels with the payment; the facilitator only broadcasts it.
const ADA = { symbol: 'ADA', decimals: 6, unit: 'lovelace' };
NETWORKS['cardano:mainnet'] = { name: 'Cardano', testnet: false, family: 'cardano', native: ADA, stablecoins: { 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d': { symbol: 'USDM', decimals: 6 } } };
NETWORKS['cardano:preprod'] = { name: 'Cardano Preprod', testnet: true, family: 'cardano', native: ADA, stablecoins: { 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d': { symbol: 'USDM', decimals: 6 } } };
NETWORKS['cardano:preview'] = { name: 'Cardano Preview', testnet: true, family: 'cardano', native: ADA };
const CARDANO_ALIASES = { 'cip34:1-764824073': 'cardano:mainnet', 'cip34:0-1': 'cardano:preprod', 'cip34:0-2': 'cardano:preview' };
for (const [alias, id] of Object.entries(CARDANO_ALIASES)) NETWORKS[alias] = NETWORKS[id];
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
  // Not in x402's v1 list (Robinhood Chain came later), but what sellers write in a v1-shaped body next to a v2
  // header (t0ll.xyz, 2 Nov 2026).
  robinhood: 'eip155:4663',
  'robinhood-chain': 'eip155:4663',
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
// Payout addresses nobody holds a key for, mostly placeholders left in a config: USDC refuses a transfer to the zero
// address, and what reaches the others can never be spent. burnAddress() names the address, or returns null.
const BURN_ADDRESSES = new Map([
  ['0x0000000000000000000000000000000000000000', 'the zero address'],
  ['0x000000000000000000000000000000000000dead', 'the 0x…dEaD burn address'],
  ['11111111111111111111111111111111', "Solana's System Program, not a wallet"],
  ['1nc1nerator11111111111111111111111111111111', "Solana's incinerator (burn) address"],
]);
const burnAddress = (value) => (typeof value === 'string' ? BURN_ADDRESSES.get(/^0x/i.test(value) ? value.toLowerCase() : value) ?? null : null);
// A deliberate token burn as the price: the payTo is a burn address (0x…dEaD or Solana's incinerator, not the zero
// address or the System Program, which refuse or aren't wallets) and the asset is not a dollar token, typically the
// seller's own token (wafermap.xyz's WAFERMAP on Robinhood Chain). The buyer pays and nobody receives: that is the
// design, not a placeholder. USDC to a burn address stays a mistake.
const TOKEN_BURN_TO = new Set(['0x000000000000000000000000000000000000dead', '1nc1nerator11111111111111111111111111111111']);
function tokenBurn(network, asset, payTo) {
  if (typeof payTo !== 'string' || typeof asset !== 'string' || !asset) return false;
  if (!TOKEN_BURN_TO.has(/^0x/i.test(payTo) ? payTo.toLowerCase() : payTo)) return false;
  return !dollarToken(network, asset);
}
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
// Stellar StrKey (SEP-23): base32 of a version byte, the payload and a CRC16-XModem checksum (little-endian). G… is an
// account (32-byte key), C… a contract (32-byte hash), M… a muxed account (32-byte key + 8-byte id). kinds: which of
// the three are accepted.
const STELLAR_VERSIONS = { G: 6 << 3, C: 2 << 3, M: 12 << 3 };
function crc16xmodem(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
function isStellarAddress(value, kinds = 'GCM') {
  if (typeof value !== 'string' || !kinds.includes(value[0]) || value.length !== (value[0] === 'M' ? 69 : 56) || !/^[A-Z2-7]+$/.test(value)) return false;
  let bits = 0, acc = 0;
  const bytes = [];
  for (const ch of value) {
    acc = ((acc << 5) | BASE32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
  }
  if (bits && acc & ((1 << bits) - 1)) return false; // leftover padding bits must be zero (a canonical encoding)
  if (bytes[0] !== STELLAR_VERSIONS[value[0]]) return false;
  const body = bytes.slice(0, -2);
  return crc16xmodem(body) === (bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8));
}
// An Algorand Standard Asset id: a positive integer, as a string.
const isAsaId = (value) => /^[1-9]\d{0,19}$/.test(String(value ?? ''));
const isXrplCurrency = (value) => typeof value === 'string' && (/^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(value) || /^[A-Fa-f0-9]{40}$/.test(value));

// A Nano account: nano_ (or the older xrb_) and 60 characters of Nano's base32 alphabet: 4 zero bits and the 32-byte
// public key (52 characters), then a 5-byte checksum (8 characters), BLAKE2b-40 of the key with its bytes reversed.
// nanoPublicKey gives the key as hex when the checksum holds, else null; a typo in a payTo fails the checksum, which
// the format alone would let through (pursekeeper.dev, 5 Nov 2026).
const NANO_ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';
const NANO_RE = /^(nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
function nanoPublicKey(a) {
  const s = String(a ?? '');
  if (!NANO_RE.test(s)) return null;
  let bits = 0n;
  for (const c of s.slice(s.indexOf('_') + 1)) bits = (bits << 5n) | BigInt(NANO_ALPHABET.indexOf(c));
  // 300 bits: 4 padding bits (zero), 256 key bits, 40 checksum bits.
  if (bits >> 296n) return null;
  const key = Buffer.from(((bits >> 40n) & ((1n << 256n) - 1n)).toString(16).padStart(64, '0'), 'hex');
  const check = Buffer.from((bits & ((1n << 40n) - 1n)).toString(16).padStart(10, '0'), 'hex');
  const want = Buffer.from(blake2b(key, 5)).reverse();
  return want.equals(check) ? key.toString('hex').toUpperCase() : null;
}
const isNanoFormat = (a) => NANO_RE.test(String(a ?? ''));
const isNanoAddress = (a) => nanoPublicKey(a) !== null;
// Concordium account address: base58check of 37 bytes, version byte 1, the 32-byte account and a 4-byte checksum
// (the first 4 bytes of SHA-256 of SHA-256 of the first 33). 50 characters. The CAIP-10 form ccd:<genesis>:<address>
// is accepted too.
function isConcordiumAddress(value) {
  const plain = typeof value === 'string' ? value.replace(/^ccd:[0-9a-f]{32}:/i, '') : value;
  if (typeof plain !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(plain)) return false;
  const bytes = base58Decode(plain);
  if (!bytes || bytes.length !== 37 || bytes[0] !== 1) return false;
  const { createHash } = require('node:crypto');
  const sum = createHash('sha256').update(createHash('sha256').update(bytes.subarray(0, 33)).digest()).digest();
  return Buffer.from(bytes.subarray(33)).equals(sum.subarray(0, 4));
}
// TRON address: base58check of 25 bytes, the 0x41 prefix, the 20-byte account and a 4-byte checksum (the first 4
// bytes of SHA-256 of SHA-256 of the first 21). Always 34 characters starting with "T".
function isTronAddress(value) {
  if (typeof value !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return false;
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x41) return false;
  const { createHash } = require('node:crypto');
  const sum = createHash('sha256').update(createHash('sha256').update(bytes.subarray(0, 21)).digest()).digest();
  return Buffer.from(bytes.subarray(21)).equals(sum.subarray(0, 4));
}

// A Cardano Shelley address (CIP-19): bech32 with hrp "addr" (mainnet) or "addr_test" (testnets), whose first byte
// holds the address type (high 4 bits: 0-3 base, 4-5 pointer, 6-7 enterprise; odd types pay a script) and the network
// id (low 4 bits: 1 mainnet, 0 testnet). Returns { mainnet, script, kind } or null. Byron (base58) addresses are not
// x402 payees: the Cardano scheme pays Shelley addresses.
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Bytes(str) {
  if (typeof str !== 'string' || str !== str.toLowerCase() || str.length > 200) return null;
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) return null;
  const hrp = str.slice(0, pos);
  const data = [...str.slice(pos + 1)].map((c) => BECH32.indexOf(c));
  if (data.some((v) => v < 0)) return null;
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data]) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  if (chk !== 1) return null;
  const bytes = [];
  let acc = 0, bits = 0;
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1))) return null;
  return { hrp, bytes };
}
function cardanoAddress(value) {
  if (typeof value !== 'string' || !/^addr(_test)?1[0-9a-z]+$/.test(value)) return null;
  const d = bech32Bytes(value);
  if (!d || !d.bytes.length) return null;
  const type = d.bytes[0] >> 4;
  const net = d.bytes[0] & 15;
  const kind = type <= 3 ? 'base' : type <= 5 ? 'pointer' : type <= 7 ? 'enterprise' : null;
  if (!kind) return null;
  const length = d.bytes.length;
  if ((kind === 'base' && length !== 57) || (kind === 'enterprise' && length !== 29) || (kind === 'pointer' && (length < 32 || length > 50))) return null;
  if ((d.hrp === 'addr') !== (net === 1) || (d.hrp === 'addr_test') !== (net === 0)) return null;
  return { mainnet: net === 1, script: (type & 1) === 1, kind };
}
// A Cardano native token unit as the scheme writes it: a 56-hex policy id, a dot, and the asset name in hex (0–32 bytes).
const CARDANO_ASSET_RE = /^[0-9a-f]{56}\.(?:[0-9a-f]{2}){0,32}$/;

function familyOf(network) {
  if (NETWORKS[network]) return NETWORKS[network].family;
  if (String(network).startsWith('solana')) return 'solana';
  if (String(network).startsWith('eip155:')) return 'evm';
  if (String(network).startsWith('xrpl:')) return 'xrpl';
  if (String(network).startsWith('algorand:')) return 'algorand';
  if (String(network).startsWith('lnbtc:')) return 'lightning';
  if (String(network).startsWith('stellar:')) return 'stellar';
  if (String(network).startsWith('nano:')) return 'nano';
  if (String(network).startsWith('tron:')) return 'tron';
  if (String(network).startsWith('ccd:')) return 'concordium';
  if (String(network).startsWith('cardano:') || String(network).startsWith('cip34:')) return 'cardano';
  return null;
}

// Circle Gateway (nanopayments): an "exact" option whose EIP-3009 authorization is signed for Circle's Gateway Wallet
// (EIP-712 domain "GatewayWalletBatched" v1, extra.verifyingContract) instead of the token. The buyer pays from a
// USDC balance deposited in the Gateway Wallet beforehand, with Circle's client (@circle-fin/x402-batching), and
// Circle settles in batches. Standard x402 clients sign for the token contract, which Gateway refuses. The Gateway
// Wallet has one address on every mainnet and another on every testnet (as listed in Circle's catalog, Oct 2026).
const GATEWAY = {
  domain: 'GatewayWalletBatched',
  version: '1',
  wallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
  testnetWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
};
const isGatewayOption = (option) => option?.scheme === 'exact' && option?.extra?.name === GATEWAY.domain;

// EVM addresses are case-insensitive (checksum casing is optional); Solana mints are exact.
function sameAsset(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return /^0x/i.test(a) && /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The dollar stablecoin an option pays in: USDC (6 decimals, 7 on Stellar) where the network has Circle's USDC, or one of the
// network's listed stablecoins (BNB Chain's have 18 decimals). null for any other asset or an unknown network.
function dollarToken(network, asset) {
  const net = NETWORKS[network];
  if (!net || typeof asset !== 'string') return null;
  if (net.usdc && sameAsset(asset, net.usdc)) return { symbol: net.usdcSymbol ?? 'USDC', decimals: net.usdcDecimals ?? 6, ...(net.usdcDomain ? { domain: net.usdcDomain } : {}) };
  // Exact key first (TRON's base58 keys keep their case), then lowercased (EVM keys are stored lowercase).
  const listed = (key) => (net.stablecoins && Object.hasOwn(net.stablecoins, key) ? net.stablecoins[key] : null);
  return listed(asset) ?? listed(asset.toLowerCase());
}

// A stablecoin an option pays in: a dollar token (above), or a euro one (EURC), marked currency: 'EUR'. For checks
// on the option itself; prices in dollars use dollarToken only.
function knownToken(network, asset) {
  const dollar = dollarToken(network, asset);
  if (dollar || typeof asset !== 'string') return dollar;
  const euro = NETWORKS[network]?.euroStablecoins?.[asset.toLowerCase()];
  return euro ? { ...euro, currency: 'EUR' } : null;
}

// Every dollar token x402 Doctor knows on a network, as [address, { symbol, … }], USDC first.
function dollarTokens(network) {
  const net = NETWORKS[network];
  if (!net) return [];
  return [...(net.usdc ? [[net.usdc, { symbol: net.usdcSymbol ?? 'USDC' }]] : []), ...Object.entries(net.stablecoins || {})];
}

module.exports = { nanoPublicKey, isNanoFormat, sameAsset, dollarToken, dollarTokens, knownToken, GATEWAY, isGatewayOption, NETWORKS, V1_NAMES, CAIP2_RE, NETWORK_ID_RE, isSolanaAddress, isEvmAddress, burnAddress, tokenBurn, isXrplAddress, isXrplCurrency, isAlgorandAddress, isAsaId, isStellarAddress, isNanoAddress, isTronAddress, isConcordiumAddress, TRON_ALIASES, cardanoAddress, CARDANO_ASSET_RE, CARDANO_ALIASES, familyOf, base58Decode };
