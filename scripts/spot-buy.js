#!/usr/bin/env node
// Weekly spot-buy sample (run by .github/workflows/spot-buy.yml). See lib/spot-buy.js.
//
//   node scripts/spot-buy.js --index trust-data/index.json --out spot-data [--n 30] [--cap 0.05] [--budget 2] [--seed 2026-10-18] [--dry]
//
// Pays only with the key in SPOT_BUY_KEY: a dedicated wallet holding a few USDC on Base, never a payout or
// personal wallet. Without the key (or with --dry) it does everything up to the payment and pays nothing.
// Writes <out>/<date>.json and <out>/latest.json, and a markdown summary to $GITHUB_STEP_SUMMARY when set.

const fs = require('fs');
const path = require('path');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createSanctions } = require('../lib/sanctions');
const { checkSettlement } = require('../lib/settlement');
const { createSpotWallet } = require('../lib/spot-wallet');
const { selectCandidates, runSpotBuy, DEFAULTS, LIMITS, OUTCOMES, BASE } = require('../lib/spot-buy');
const { readIndexFile } = require('../lib/index-files');
const { createAnswerCheck } = require('../lib/jev-answer');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

async function main() {
  const indexPath = arg('index', 'trust-data/index.json');
  const out = arg('out', 'spot-data');
  const n = Math.min(num(arg('n', process.env.SPOT_BUY_N), DEFAULTS.n), LIMITS.n);
  const capUsd = Math.min(num(arg('cap', process.env.SPOT_BUY_MAX_USD), DEFAULTS.capUsd), LIMITS.capUsd);
  const budgetUsd = Math.min(num(arg('budget', process.env.SPOT_BUY_BUDGET_USD), DEFAULTS.budgetUsd), LIMITS.budgetUsd);
  const seed = arg('seed', new Date().toISOString().slice(0, 10));
  const key = process.env.SPOT_BUY_KEY;
  const dry = process.argv.includes('--dry') || !key;

  const index = readIndexFile(indexPath);
  const { pool, picks } = selectCandidates(index, { n, capUsd, seed });
  console.log(`index ${index.days?.at(-1)}: ${pool.resources} candidates on ${pool.hosts} hosts; sample ${picks.length} (seed ${seed}), cap $${capUsd}, budget $${budgetUsd}, ${dry ? 'DRY RUN' : 'LIVE'}`);

  const sanctions = createSanctions();
  const list = await sanctions.ready({ waitMs: 30000 });
  if (!list) throw new Error(`OFAC list unavailable (${sanctions.status().lastError ?? 'timeout'}): not buying without the payout screen`);

  let payFetch = null, address = null, balance = async () => null;
  if (!dry) {
    ({ address, payFetch, balance } = createSpotWallet({ key, capUsd, rpc: process.env.BASE_RPC_URL || undefined }));
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
    // Is each answer what was paid for (TypeSafe's Jev, with TYPESAFE_API_KEY)? No hurry here: a longer wait than live.
    answer: createAnswerCheck({ timeoutMs: 10000 }),
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
