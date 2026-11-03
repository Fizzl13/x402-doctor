// Real payments on chain on Monad (eip155:143): the same count as on Base and X Layer (lib/onchain-payments.js), for
// the payout addresses of the Trust Index endpoints that take USDC on Monad. Only transfers the payer signed with
// EIP-3009 (transferWithAuthorization, the way x402's exact scheme settles) count, in Circle's USDC (6 decimals).
// Monad makes a block about every 0.3 seconds (measured over 250,000 blocks on 3 Nov 2026), and its public node
// (rpc.monad.xyz) answers getLogs for at most 100 blocks at a time, so the hourly run reads about 12,000 blocks in
// 120 steps. Collected by scripts/onchain-payments.js (payments-monad.json on the payments-data branch). Read-only: it
// never pays and holds no key.

const { NETWORKS, isEvmAddress, burnAddress } = require('./networks');
const { collect } = require('./onchain-payments');

const MONAD = 'eip155:143';
const USDC = NETWORKS[MONAD].usdc.toLowerCase();
const TOKENS = [USDC];
const SYMBOL = 'USDC';
const PUBLIC_RPC = 'https://rpc.monad.xyz';
const BLOCK_SECONDS = 0.3;
const CHAIN = { network: MONAD, tokens: TOKENS, blockSeconds: BLOCK_SECONDS, symbol: SYMBOL };
const STEP = 100; // blocks per getLogs call: the most rpc.monad.xyz serves
const FIRST_RUN = 30000; // blocks a first run reads back: 2.5 hours, as on X Layer
const MAX_BLOCKS = 200000; // a longer gap (about 17 hours) is skipped and shows as lower coverage, as on X Layer

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const watchable = (a) => isEvmAddress(a) && !burnAddress(a);

// The Monad payout addresses (offers in USDC) the daily scan saw, kept for 14 days, with the hosts of the Trust Index
// endpoints that pay to them (at most 3), for the public list of who gets paid.
function mergeMonadPayTos(previous, results, date, keepDays = 14) {
  const payTos = { ...(previous?.pay_tos || {}) };
  const seenHosts = {};
  for (const r of results) {
    let host = null;
    try { host = new URL(r?.url).hostname; } catch { /* no URL */ }
    for (const raw of r?.monad_pay_tos || []) {
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
  return { network: MONAD, updated: date, pay_tos: payTos, ...(Object.keys(hosts).length ? { hosts } : {}) };
}

// One hourly step: the blocks since the last run, 100 at a time.
function collectMonad(state, options = {}) {
  return collect(state, { chunk: STEP, archiveSafe: FIRST_RUN, maxBlocks: MAX_BLOCKS, nodes: [PUBLIC_RPC], ...options, chain: CHAIN });
}

// A USDC offer on Monad to a real payout address: the ones counted.
const isMonadUsdc = (network, asset) => network === MONAD && String(asset).toLowerCase() === USDC;

module.exports = { MONAD, USDC, TOKENS, SYMBOL, PUBLIC_RPC, BLOCK_SECONDS, mergeMonadPayTos, collectMonad, isMonadUsdc };
