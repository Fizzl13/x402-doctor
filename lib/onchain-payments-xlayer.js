// Real payments on chain on X Layer (eip155:196): the same count as on Base (lib/onchain-payments.js), for the
// payout addresses of the Trust Index endpoints that take dollars on X Layer. Only transfers the payer signed with
// EIP-3009 (transferWithAuthorization, the way x402's exact scheme settles) count, in USD₮0 or USDC, both 6 decimals.
// X Layer makes a block every second, and its public node (rpc.xlayer.tech) answers getLogs for at most 100 blocks
// at a time, so the hourly run reads 3,600 blocks in 36 steps. Collected by scripts/onchain-payments.js
// (payments-xlayer.json on the payments-data branch). Read-only: it never pays and holds no key.

const { NETWORKS, isEvmAddress, burnAddress } = require('./networks');
const { collect, ARCHIVE_SAFE } = require('./onchain-payments');

const XLAYER = 'eip155:196';
// The dollar tokens x402 sellers name on X Layer that settle by EIP-3009: USDC and USD₮0 (lib/networks.js).
const TOKENS = [NETWORKS[XLAYER].usdc, ...Object.keys(NETWORKS[XLAYER].stablecoins || {})].map((a) => a.toLowerCase());
const SYMBOL = 'USD₮0 or USDC';
const PUBLIC_RPC = 'https://rpc.xlayer.tech';
const CHAIN = { network: XLAYER, tokens: TOKENS, blockSeconds: 1, symbol: SYMBOL };
const STEP = 100; // blocks per getLogs call: the most rpc.xlayer.tech serves

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const watchable = (a) => isEvmAddress(a) && !burnAddress(a);

// The X Layer payout addresses (offers in one of TOKENS) the daily scan saw, kept for 14 days, with the hosts of the
// Trust Index endpoints that pay to them (at most 3), for the public list of who gets paid.
function mergeXlayerPayTos(previous, results, date, keepDays = 14) {
  const payTos = { ...(previous?.pay_tos || {}) };
  const seenHosts = {};
  for (const r of results) {
    let host = null;
    try { host = new URL(r?.url).hostname; } catch { /* no URL */ }
    for (const raw of r?.xlayer_pay_tos || []) {
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
  return { network: XLAYER, updated: date, pay_tos: payTos, ...(Object.keys(hosts).length ? { hosts } : {}) };
}

// One hourly step: the blocks since the last run, 100 at a time. A first run starts ARCHIVE_SAFE blocks back (2.5
// hours here), as on Base; a gap of more than maxBlocks (about 17 hours) is skipped and shows as lower coverage.
function collectXlayer(state, options = {}) {
  return collect(state, { chunk: STEP, archiveSafe: ARCHIVE_SAFE, maxBlocks: 60000, nodes: [PUBLIC_RPC], ...options, chain: CHAIN });
}

module.exports = { XLAYER, TOKENS, SYMBOL, PUBLIC_RPC, mergeXlayerPayTos, collectXlayer };
