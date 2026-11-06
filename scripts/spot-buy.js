#!/usr/bin/env node
// Weekly spot-buy sample (run by .github/workflows/spot-buy.yml). See lib/spot-buy.js.
//
//   node scripts/spot-buy.js --index trust-data/index.json --out spot-data [--history spot-history/results] [--retest 3]
//     [--n 30] [--cap 0.05] [--budget 2] [--seed 2026-10-18] [--dry]
//
// --history: the earlier run reports (the spot-data branch's results/). After the random sample, up to --retest sellers
// whose last purchase failed on their side are bought again, within the same budget, and reported apart (retests).
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
const { selectCandidates, selectRetests, summarizeRetests, runSpotBuy, RETEST, DEFAULTS, LIMITS, OUTCOMES, BASE } = require('../lib/spot-buy');
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
  const historyDir = arg('history', null);
  const retestN = Math.max(0, Math.min(num(arg('retest', process.env.SPOT_BUY_RETEST), RETEST.n), 10));
  const history = historyDir && fs.existsSync(historyDir)
    ? fs.readdirSync(historyDir).filter((f) => /^\d{4}-\d{2}-\d{2}(-\d+)?\.json$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8')); } catch { return null; } }).filter(Boolean)
    : [];
  const retests = selectRetests(history, index, { n: retestN, capUsd, exclude: new Set(picks.map((p) => p.host)) });
  console.log(`re-checks: ${retests.length} of ${history.length} earlier runs (${retests.map((r) => `${r.host} ${r.previous.result}`).join(', ') || 'none due'})`);
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
  const deps = {
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
  };
  const { results, summary } = await runSpotBuy(picks, deps);
  // The re-checks, within what is left of the same budget, reported apart so the sample stays random.
  const left = Math.max(0, budgetUsd - (summary.spent_usd || 0));
  const re = retests.length && left > 0 ? await runSpotBuy(retests, { ...deps, budgetUsd: left }) : null;
  const retest = re ? { rules: { n: retestN, max_age_days: RETEST.maxAgeDays }, summary: { ...summarizeRetests(re.results, retests), spent_usd: re.summary.spent_usd }, results: re.results } : null;

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
    ...(retest ? { retests: retest } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (retest) console.log('re-checks', JSON.stringify(retest.summary, null, 2));
  if (!dry) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${date}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(report, null, 2));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`## Spot-buy ${date} (${dry ? 'dry run, nothing paid' : 'live'})`, '', `Sample ${picks.length} of ${pool.resources} "go" endpoints on ${pool.hosts} hosts (seed ${seed}); cap $${capUsd} per call, budget $${budgetUsd}.`, '', '```json', JSON.stringify(summary, null, 2), '```', '', '| Result | Price | Endpoint |', '|---|---|---|', ...results.map((r) => `| ${r.result} | ${r.price_usd ?? ''} | ${r.url} |`)];
    if (retest) lines.push('', `### Re-checks (${retest.summary.rechecked} bought again, ${retest.summary.fixed} fixed)`, '', '| Before | Now | Endpoint |', '|---|---|---|', ...retest.results.map((r) => `| ${r.previous?.result ?? ''} | ${r.result} | ${r.url} |`));
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
