// Real payments on chain on more EVM networks: the same count as on Base, X Layer and Monad (lib/onchain-payments.js),
// for the payout addresses of the Trust Index endpoints that take Circle's USDC there. Only transfers the payer signed
// with EIP-3009 (transferWithAuthorization, the way x402's exact scheme settles) count. One entry per network: its
// CAIP-2 id, a public node that answers eth_getLogs filtered by the USDC contract, the block time and how many blocks
// one call may cover. Collected by scripts/onchain-payments.js (payments-<key>.json on the payments-data branch, from
// paytos-<key>.json on trust-data). Read-only: it never pays and holds no key.
//
// Measured on 5 Nov 2026: polygon-bor-rpc.publicnode.com serves 10,000 blocks per getLogs when the call names the
// contract (2-second blocks: about 5.5 hours); arb1.arbitrum.io serves 10,000 too (0.25-second blocks: about 42
// minutes), now and then with a 429: collect() then stops at that block and the next hourly run goes on from there.
// Added the same day: avalanche-c-chain-rpc.publicnode.com and optimism-rpc.publicnode.com, 10,000 blocks per call
// as well (Avalanche C-Chain made 1,019 blocks in 964 seconds, Optimism one every 2 seconds). api.avax.network allows
// only 100 blocks per call, so it is not used. World Chain, Arc and HyperEVM have no free node that serves more
// than 100 to 1,000 blocks per call reliably, so they are not counted yet.

const { NETWORKS, isEvmAddress, burnAddress } = require('./networks');
const { collect } = require('./onchain-payments');

// Polygon (443 sellers in the 5 Nov Trust Index) and Arbitrum (396): the two biggest networks not counted before;
// then Avalanche (62 sellers) and Optimism (46).
const CHAINS = {
  polygon: { network: 'eip155:137', name: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', env: 'POLYGON_RPC_URL', blockSeconds: 2, step: 5000, firstRun: 5400, maxBlocks: 60000 },
  arbitrum: { network: 'eip155:42161', name: 'Arbitrum', rpc: 'https://arb1.arbitrum.io/rpc', env: 'ARBITRUM_RPC_URL', blockSeconds: 0.25, step: 5000, firstRun: 36000, maxBlocks: 300000 },
  avalanche: { network: 'eip155:43114', name: 'Avalanche', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', env: 'AVALANCHE_RPC_URL', blockSeconds: 0.95, step: 5000, firstRun: 11400, maxBlocks: 120000 },
  optimism: { network: 'eip155:10', name: 'Optimism', rpc: 'https://optimism-rpc.publicnode.com', env: 'OPTIMISM_RPC_URL', blockSeconds: 2, step: 5000, firstRun: 5400, maxBlocks: 60000 },
};
for (const c of Object.values(CHAINS)) c.usdc = NETWORKS[c.network].usdc.toLowerCase();
const KEYS = Object.keys(CHAINS);
const keyOf = (network) => KEYS.find((k) => CHAINS[k].network === network) || null;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const watchable = (a) => isEvmAddress(a) && !burnAddress(a);

// A USDC offer on one of these networks: the ones counted.
const isEvmUsdc = (network, asset) => {
  const k = keyOf(network);
  return Boolean(k) && String(asset).toLowerCase() === CHAINS[k].usdc;
};

// The payout addresses (offers in USDC) the daily scan saw on one network (results carry `<key>_pay_tos`), kept for
// 14 days, with the hosts of the Trust Index endpoints that pay to them (at most 3), for the public list.
function mergeEvmPayTos(key, previous, results, date, keepDays = 14) {
  const chain = CHAINS[key];
  const payTos = { ...(previous?.pay_tos || {}) };
  const seenHosts = {};
  for (const r of results) {
    let host = null;
    try { host = new URL(r?.url).hostname; } catch { /* no URL */ }
    for (const raw of r?.[`${key}_pay_tos`] || []) {
      if (!watchable(raw)) continue;
      const a = raw.toLowerCase();
      payTos[a] = date;
      const list = seenHosts[a] || (seenHosts[a] = []);
      if (host && !list.includes(host) && list.length < 3) list.push(host);
    }
  }
  const hosts = { ...(previous?.hosts || {}), ...Object.fromEntries(Object.entries(seenHosts).filter(([, list]) => list.length)) };
  const cutoff = dayOf(Date.parse(`${date}T00:00:00Z`) - keepDays * 86400000);
  for (const [a, last] of Object.entries(payTos)) if (last < cutoff) delete payTos[a];
  for (const a of Object.keys(hosts)) if (!payTos[a]) delete hosts[a];
  return { network: chain.network, updated: date, pay_tos: payTos, ...(Object.keys(hosts).length ? { hosts } : {}) };
}

// The `<key>_pay_tos` of one checked endpoint's options (lib/trust-scan.js payTosOf).
function evmPayTosOf(options) {
  const out = {};
  for (const key of KEYS) {
    const list = [...new Set(options.filter((o) => isEvmUsdc(o.network, o.asset) && keyOf(o.network) === key && watchable(o.pay_to)).map((o) => o.pay_to.toLowerCase()))];
    if (list.length) out[`${key}_pay_tos`] = list;
  }
  return out;
}

// One hourly step on one network: the blocks since the last run.
function collectEvm(key, state, options = {}) {
  const c = CHAINS[key];
  return collect(state, { chunk: c.step, archiveSafe: c.firstRun, maxBlocks: c.maxBlocks, nodes: [c.rpc], ...options, chain: { network: c.network, tokens: [c.usdc], blockSeconds: c.blockSeconds, symbol: 'USDC' } });
}

module.exports = { CHAINS, KEYS, keyOf, isEvmUsdc, mergeEvmPayTos, evmPayTosOf, collectEvm };
