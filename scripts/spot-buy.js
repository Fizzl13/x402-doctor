#!/usr/bin/env node
// Weekly spot-buy sample (run by .github/workflows/spot-buy.yml). See lib/spot-buy.js.
//
//   node scripts/spot-buy.js --index trust-data/index.json --out spot-data [--n 30] [--cap 0.05] [--budget 2] [--seed 2026-W42] [--dry]
//
// Pays only with the key in SPOT_BUY_KEY: a dedicated wallet holding a few USDC on Base, never a payout or
// personal wallet. Without the key (or with --dry) it does everything up to the payment and pays nothing.
// Writes <out>/<date>.json and <out>/latest.json, and a markdown summary to $GITHUB_STEP_SUMMARY when set.

const fs = require('fs');
const path = require('path');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createSanctions } = require('../lib/sanctions');
const { checkSettlement } = require('../lib/settlement');
const { NETWORKS } = require('../lib/networks');
const { selectCandidates, runSpotBuy, isoWeek, DEFAULTS, LIMITS, OUTCOMES, BASE } = require('../lib/spot-buy');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

async function usdcBalance(address, rpc) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: NETWORKS[BASE].usdc, data }, 'latest'] }), signal: AbortSignal.timeout(15000) });
  const j = await res.json();
  if (!j.result) throw new Error(j.error?.message || 'no result');
  return Number(BigInt(j.result));
}

async function main() {
  const indexPath = arg('index', 'trust-data/index.json');
  const out = arg('out', 'spot-data');
  const n = Math.min(num(arg('n', process.env.SPOT_BUY_N), DEFAULTS.n), LIMITS.n);
  const capUsd = Math.min(num(arg('cap', process.env.SPOT_BUY_MAX_USD), DEFAULTS.capUsd), LIMITS.capUsd);
  const budgetUsd = Math.min(num(arg('budget', process.env.SPOT_BUY_BUDGET_USD), DEFAULTS.budgetUsd), LIMITS.budgetUsd);
  const seed = arg('seed', isoWeek());
  const key = process.env.SPOT_BUY_KEY;
  const dry = process.argv.includes('--dry') || !key;
  const rpc = process.env.BASE_RPC_URL || NETWORKS[BASE].rpc;

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const { pool, picks } = selectCandidates(index, { n, capUsd, seed });
  console.log(`index ${index.days?.at(-1)}: ${pool.resources} candidates on ${pool.hosts} hosts; sample ${picks.length} (seed ${seed}), cap $${capUsd}, budget $${budgetUsd}, ${dry ? 'DRY RUN' : 'LIVE'}`);

  const sanctions = createSanctions();
  const list = await sanctions.ready({ waitMs: 30000 });
  if (!list) throw new Error(`OFAC list unavailable (${sanctions.status().lastError ?? 'timeout'}): not buying without the payout screen`);

  let payFetch = null, address = null, balance = async () => null;
  if (!dry) {
    const { wrapFetchWithPayment, x402Client } = require('@x402/fetch');
    const { ExactEvmScheme } = require('@x402/evm/exact/client');
    const { privateKeyToAccount } = require('viem/accounts');
    const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
    address = account.address;
    const client = new x402Client((_version, accepts) => accepts.find((a) => a.network === BASE && a.scheme === 'exact'))
      .setSpendControls({ maxAmountPerPayment: `$${capUsd}` });
    client.register(BASE, new ExactEvmScheme(account));
    payFetch = wrapFetchWithPayment(fetch, client);
    balance = () => usdcBalance(address, rpc);
    const start = await balance();
    console.log(`wallet ${address}: ${(start / 1e6).toFixed(2)} USDC on Base`);
    if (start / 1e6 < capUsd) throw new Error(`wallet ${address} holds ${(start / 1e6).toFixed(2)} USDC on Base: fund it with a few USDC first`);
  }

  const startedAt = new Date().toISOString();
  const { results, summary } = await runSpotBuy(picks, {
    safeFetch: createSafeFetch({ allowPrivate: false, timeoutMs: 15000 }),
    payFetch,
    sanctions,
    balance,
    settlement: (header) => checkSettlement(header, { rpcUrls: process.env.BASE_RPC_URL ? { [BASE]: process.env.BASE_RPC_URL } : {} }),
    capUsd,
    budgetUsd,
    log: (line) => console.log(line),
  });

  const date = startedAt.slice(0, 10);
  const report = {
    date,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    seed,
    index_date: index.days?.at(-1) ?? null,
    rules: { n, cap_usd: capUsd, budget_usd: budgetUsd, network: BASE, asset: 'USDC', scheme: 'exact', one_per_host: true },
    wallet: address,
    sanctions_list: { published: list.published, addresses: list.count },
    pool,
    summary,
    outcomes_legend: OUTCOMES,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!dry) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${date}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(report, null, 2));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`## Spot-buy ${date} (${dry ? 'dry run, nothing paid' : 'live'})`, '', `Sample ${picks.length} of ${pool.resources} "go" endpoints on ${pool.hosts} hosts (seed ${seed}); cap $${capUsd} per call, budget $${budgetUsd}.`, '', '```json', JSON.stringify(summary, null, 2), '```', '', '| Result | Price | Endpoint |', '|---|---|---|', ...results.map((r) => `| ${r.result} | ${r.price_usd ?? ''} | ${r.url} |`)];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
