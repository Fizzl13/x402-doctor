#!/usr/bin/env node
// Paid delivery checks (run by .github/workflows/delivery-check.yml every 10 minutes). See lib/delivery-checks.js.
//
//   node scripts/delivery-check.js --index delivery-data/index.json --out delivery-data [--queue <url>] [--dry]
//
// Takes the queue of paid jobs from x402 Doctor, buys each endpoint once with the spot-buy wallet (SPOT_BUY_KEY,
// at most $0.10 a purchase) and writes <out>/results/<id>.json and <out>/index.json. Without the key (or with
// --dry) it does everything up to the payment and writes nothing.

const fs = require('fs');
const path = require('path');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createSanctions } = require('../lib/sanctions');
const { checkSettlement } = require('../lib/settlement');
const { createSpotWallet } = require('../lib/spot-wallet');
const { runSpotBuy, BASE } = require('../lib/spot-buy');
const { jobsToRun, candidateOf, recordOf, RETRY, USER_AGENT } = require('../lib/delivery-runner');
const { CAP_USD } = require('../lib/delivery-checks');
const { createAnswerCheck } = require('../lib/jev-answer');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const queueUrl = arg('queue', process.env.DELIVERY_QUEUE_URL || 'https://x402-doctor.fizzl.eu/api/v1/delivery-check/queue');
  const indexPath = arg('index', 'delivery-data/index.json');
  const out = arg('out', 'delivery-data');
  const key = process.env.SPOT_BUY_KEY;
  const dry = process.argv.includes('--dry') || !key;

  const res = await fetch(queueUrl, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`queue HTTP ${res.status}`);
  const queue = await res.json();
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { results: {} };
  const jobs = jobsToRun(queue, index);
  console.log(`queue ${queue.jobs?.length ?? 0}, to buy now ${jobs.length}, ${dry ? 'DRY RUN' : 'LIVE'}`);
  if (!jobs.length) return;

  const sanctions = createSanctions();
  if (!(await sanctions.ready({ waitMs: 30000 }))) throw new Error('OFAC list unavailable: not buying without the payout screen');
  let wallet = null;
  if (!dry) {
    wallet = createSpotWallet({ key, capUsd: CAP_USD, rpc: process.env.BASE_RPC_URL || undefined });
    console.log(`wallet ${wallet.address}: ${((await wallet.balance()) / 1e6).toFixed(2)} USDC on Base`);
  }

  // Is the answer what was paid for (TypeSafe's Jev, with TYPESAFE_API_KEY)? No hurry here, so a longer wait than live.
  const answer = createAnswerCheck({ timeoutMs: 10000 });
  const done = [];
  for (const job of jobs) {
    const { results } = await runSpotBuy([candidateOf(job)], {
      safeFetch: createSafeFetch({ allowPrivate: false, timeoutMs: 15000 }),
      payFetch: wallet?.payFetch ?? null,
      sanctions,
      balance: wallet ? wallet.balance : async () => null,
      settlement: (header) => checkSettlement(header, { rpcUrls: process.env.BASE_RPC_URL ? { [BASE]: process.env.BASE_RPC_URL } : {} }),
      capUsd: CAP_USD,
      budgetUsd: CAP_USD,
      userAgent: USER_AGENT,
      answer,
    });
    const r = results[0];
    console.log(`${job.id} ${r.result} ${r.price_usd ?? ''} ${job.url}`);
    if (RETRY.has(r.result)) { console.log('wallet is out of funds: the rest stays queued'); break; }
    done.push(recordOf(job, r));
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`## Delivery checks (${dry ? 'dry run, nothing paid' : 'live'})`, '', '| Job | Result | What was paid for (Jev) | Price | Charged | Endpoint |', '|---|---|---|---|---|---|', ...done.map((d) => `| ${d.id} | ${d.result} | ${d.answer?.delivered?.verdict ?? ''}${d.answer?.injection?.flagged ? ', instructions for the agent' : ''} | ${d.price_usd ?? ''} | ${d.charged_usd ?? ''} | ${d.url} |`)];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  if (dry || !done.length) return;
  fs.mkdirSync(path.join(out, 'results'), { recursive: true });
  for (const d of done) {
    fs.writeFileSync(path.join(out, 'results', `${d.id}.json`), JSON.stringify(d, null, 2));
    index.results = { ...(index.results || {}), [d.id]: d };
  }
  index.updated = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
