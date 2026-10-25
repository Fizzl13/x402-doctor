#!/usr/bin/env node
// Daily x402 Trust Index scan (run by .github/workflows/trust-scan.yml).
//
//   node scripts/trust-scan.js --out trust-data [--limit 200]
//
// Reads the previous 30-day index from <out> (index/, or index.json from before the parts; lib/index-files.js), scans
// every resource in the CDP Bazaar (x402), the MPP directory (Stripe + Tempo), the GoPlausible facilitator's
// discovery list (x402 on Algorand) and Circle's Agent Marketplace catalog, and writes the index to <out>/index/ (and
// index.json while it fits) and <out>/summary.json. Every payout address is screened against the OFAC SDN list.
// Endpoints their sellers added on Doctor (/api/trust/submitted) are scanned too, into <out>/submitted.json (read
// from <out> like the index): kept apart, so the index and its numbers stay what the registries list.
//
// The workflow runs the same in three steps, so the scan itself spreads over parallel jobs: in one job it took 57
// minutes on 25 Oct 2026, twice the day before, and a job stops at 3 hours.
//   node scripts/trust-scan.js --plan plan.json --out trust-data [--limit 200]          the catalogs, read once
//   node scripts/trust-scan.js --shard 2/4 --plan plan.json --results results/2.json    one job's share of the sellers
//   node scripts/trust-scan.js --merge results --plan plan.json --out trust-data       the index from the shares
// All of a seller's endpoints are in the same share (by a hash of the host), so it still gets at most two requests at
// a time. A share that did not finish leaves its endpoints not checked that day ('-'), never marked down.

const fs = require('fs');
const path = require('path');
const { createSafeFetch } = require('../lib/safe-fetch');
const { loadCatalog, loadMppCatalog, loadGoPlausibleCatalog, loadCircleCatalog, loadXrplHub, loadSubmissions, submittedResources, scan, mergeIndex, summarize, shareOf, hostOf } = require('../lib/trust-scan');
const { mergePayTos } = require('../lib/onchain-payments');
const { mergeSolanaPayTos } = require('../lib/onchain-payments-solana');
const { mergeXrplPayTos } = require('../lib/onchain-payments-xrpl');
const { createSanctions } = require('../lib/sanctions');
const { readIndexDir, writeIndexDir } = require('../lib/index-files');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// What to scan today: every registry's resources (an endpoint in two registries once), and the endpoints sellers
// added that no registry lists by now.
async function plan({ out, limit }) {
  const previousSubmitted = read(path.join(out, 'submitted.json'));
  let resources = await loadCatalog();
  console.log(`catalog: ${resources.length} resources`);
  // The MPP directory too (Stripe + Tempo). An endpoint already in the Bazaar is checked once, as x402.
  const mpp = await loadMppCatalog().catch((err) => (console.warn(`MPP directory: ${err.message}`), []));
  const seen = new Set(resources.map((r) => r.key));
  const mppOnly = mpp.filter((r) => !seen.has(r.key));
  console.log(`MPP directory: ${mpp.length} endpoints, ${mppOnly.length} not in the Bazaar`);
  resources = [...resources, ...mppOnly];
  // The GoPlausible facilitator's listings (mostly Algorand, not in the Bazaar); one check per endpoint.
  const goplausible = await loadGoPlausibleCatalog().catch((err) => (console.warn(`GoPlausible discovery: ${err.message}`), []));
  const known = new Set(resources.map((r) => r.key));
  const gpOnly = goplausible.filter((r) => !known.has(r.key));
  console.log(`GoPlausible discovery: ${goplausible.length} endpoints, ${gpOnly.length} new`);
  resources = [...resources, ...gpOnly];
  // Circle's Agent Marketplace catalog (Circle Gateway sellers the Bazaar mostly doesn't list); one check per endpoint.
  const circle = await loadCircleCatalog().catch((err) => (console.warn(`Circle discovery: ${err.message}`), []));
  const listed = new Set(resources.map((r) => r.key));
  const circleOnly = circle.filter((r) => !listed.has(r.key));
  console.log(`Circle Agent Marketplace: ${circle.length} endpoints, ${circleOnly.length} new`);
  resources = [...resources, ...circleOnly];
  // The XRPL AI Hub (t54's XRPL facilitator): its merchants' APIs, most in no other registry; one check per endpoint.
  // Its merchant addresses also go to the hourly XRPL payment count, listed API or not.
  const hub = await loadXrplHub().catch((err) => (console.warn(`XRPL AI Hub: ${err.message}`), { resources: [], merchants: [] }));
  const indexed = new Set(resources.map((r) => r.key));
  const hubOnly = hub.resources.filter((r) => !indexed.has(r.key));
  console.log(`XRPL AI Hub: ${hub.merchants.length} merchants, ${hub.resources.length} endpoints, ${hubOnly.length} new`);
  resources = [...resources, ...hubOnly];
  if (limit > 0) resources = resources.slice(0, limit);
  // Added by their sellers: yesterday's plus the new submissions, without what a registry lists by now.
  const submissions = await loadSubmissions({ ...(process.env.TRUST_SUBMISSIONS_URL ? { url: process.env.TRUST_SUBMISSIONS_URL } : {}) })
    .catch((err) => (console.warn(`submissions: ${err.message}`), []));
  const added = submittedResources(previousSubmitted, submissions, new Set(resources.map((r) => r.key)));
  console.log(`added by sellers: ${submissions.length} submissions, ${added.length} to scan`);
  return { date: new Date().toISOString().slice(0, 10), resources, added, hub_merchants: hub.merchants, hub_names: hub.names || {} };
}

function printSlowHosts(rows) {
  if (!rows.length) return;
  console.log('hosts cut short (not checked today):');
  for (const r of rows) console.log(`  ${r.host}: ${r.skipped} endpoints skipped (${r.why})`);
}

// One job's share of the plan (all of it with shares 1): the results, and what its log says about the sellers.
async function scanShare(todo, { share = 0, shares = 1 } = {}) {
  // Every payout address against the OFAC SDN list (presign-guard's open copy). Without the list the scan runs
  // unscreened and says so.
  const sanctions = createSanctions();
  const list = await sanctions.ready({ waitMs: 30000 });
  console.log(list ? `sanctions: ${list.count} OFAC SDN addresses (published ${list.published})` : `sanctions: list unavailable (${sanctions.status().lastError ?? 'timeout'}), scanning unscreened`);

  const mine = [...todo.resources, ...todo.added].filter((r) => shares === 1 || shareOf(hostOf(r), shares) === share);
  if (shares > 1) console.log(`share ${share + 1} of ${shares}: ${mine.length} endpoints on ${new Set(mine.map(hostOf)).size} hosts`);
  const started = Date.now();
  let statuses = [];
  let slowHosts = [];
  const results = await scan(mine, {
    sanctions: list ? sanctions : null,
    safeFetch: createSafeFetch({ allowPrivate: false, timeoutMs: 10000 }),
    rpcUrl: process.env.SOLANA_RPC_URL || undefined,
    day: todo.date,
    statusTop: Infinity,
    onProgress: (done, total) => console.log(`scanned ${done}/${total} (${Math.round((Date.now() - started) / 1000)} s)`),
    onSlowHosts: (rows) => { slowHosts = rows; },
    onStatuses: (rows) => { statuses = rows; },
  });
  // Sellers cut short because they stopped answering in time: not checked today, never marked down.
  printSlowHosts(slowHosts);
  return { share, shares, seconds: Math.round((Date.now() - started) / 1000), sanctions: list ? { list: 'OFAC SDN', published: list.published, addresses: list.count } : null, statuses, slow_hosts: slowHosts, results };
}

// The index, summary, submitted list and payout addresses from today's shares and yesterday's files in <out>.
function merge(todo, done, { out }) {
  const shares = done[0].shares;
  const missing = Array.from({ length: shares }, (_, i) => i).filter((i) => !done.some((d) => d.share === i));
  if (missing.length) console.log(`shares not finished: ${missing.map((i) => i + 1).join(', ')} of ${shares}; their endpoints count as not checked today`);
  // Why sellers came out no_go: the hosts with the most answers other than 402, by status (a host is in one share).
  const statuses = done.flatMap((d) => d.statuses).sort((a, b) => b.total - a.total).slice(0, 10);
  console.log('non-402 answers by host (top 10):');
  for (const r of statuses) console.log(`  ${r.host}: ${r.total} (${Object.entries(r.statuses).map(([k, v]) => `${k} x${v}`).join(', ')})`);
  if (shares > 1) printSlowHosts(done.flatMap((d) => d.slow_hosts));

  const all = done.flatMap((d) => d.results);
  const addedKeys = new Set(todo.added.map((r) => r.key));
  const results = all.filter((r) => !addedKeys.has(r.key));
  const previous = readIndexDir(out);
  const submittedPath = path.join(out, 'submitted.json');
  const previousSubmitted = read(submittedPath);
  const descriptions = new Map(todo.resources.map((r) => [r.key, r.description]));
  const index = mergeIndex(previous, results, { date: todo.date, descriptions });
  // Only what was scanned today stays: an endpoint a registry lists now, or that stopped being payable, drops out.
  const submitted = mergeIndex(previousSubmitted, all.filter((r) => addedKeys.has(r.key)), { date: todo.date });
  submitted.resources = Object.fromEntries(Object.entries(submitted.resources).filter(([key]) => addedKeys.has(key)));
  // Which list today's payout screen used (null: the list was unavailable and the scan, or a share of it, ran
  // unscreened).
  const unscreened = done.filter((d) => !d.sanctions);
  if (unscreened.length && unscreened.length < done.length) console.log(`sanctions: list unavailable in share ${unscreened.map((d) => d.share + 1).join(', ')}, scanning unscreened there`);
  index.sanctions = unscreened.length ? null : done[0].sanctions;
  const summary = {
    ...summarize(index),
    submitted: Object.keys(submitted.resources).length,
    scan_seconds: Math.max(...done.map((d) => d.seconds)),
    ...(shares > 1 ? { shares: { finished: done.length, of: shares } } : {}),
  };

  const written = writeIndexDir(out, index);
  console.log(`index: ${written.count} resources in ${written.parts.length} parts (${Math.round(written.bytes / 1e6)} MB)${written.single ? ', also as index.json' : '; index.json left out (too large for one file)'}`);
  fs.writeFileSync(submittedPath, JSON.stringify(submitted));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  // The payout addresses on Base, for the hourly count of real payments (scripts/onchain-payments.js).
  // Endpoints sellers added count too: the web check tells them their payments are counted once they are in.
  const payTosPath = path.join(out, 'paytos.json');
  const payTos = mergePayTos(read(payTosPath), all, todo.date);
  fs.writeFileSync(payTosPath, JSON.stringify(payTos));
  console.log(`payout addresses on Base: ${Object.keys(payTos.pay_tos).length}`);
  // The same for Solana: USDC payout addresses and the facilitators that pay their fees.
  const solPath = path.join(out, 'paytos-solana.json');
  const solPayTos = mergeSolanaPayTos(read(solPath), all, todo.date);
  fs.writeFileSync(solPath, JSON.stringify(solPayTos));
  console.log(`payout addresses on Solana: ${Object.keys(solPayTos.pay_tos).length}, facilitator fee payers: ${Object.keys(solPayTos.fee_payers).length}`);
  // And for the XRP Ledger.
  const xrplPath = path.join(out, 'paytos-xrpl.json');
  const xrplPayTos = mergeXrplPayTos(read(xrplPath), [...all, { xrpl_pay_tos: todo.hub_merchants }], todo.date, 14, todo.hub_names);
  fs.writeFileSync(xrplPath, JSON.stringify(xrplPayTos));
  console.log(`payout addresses on the XRP Ledger: ${Object.keys(xrplPayTos.pay_tos).length}, ${Object.keys(xrplPayTos.names || {}).length} with a hub name`);
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const out = arg('out', 'trust-data');
  const planPath = arg('plan', null);
  const shard = arg('shard', null);
  const mergeDir = arg('merge', null);
  fs.mkdirSync(out, { recursive: true });

  if (shard) {
    const [n, of] = shard.split('/').map(Number);
    if (!(Number.isInteger(n) && Number.isInteger(of) && n >= 1 && n <= of)) throw new Error(`--shard wants <n>/<of>, e.g. 2/4 (got ${shard})`);
    const todo = read(planPath);
    if (!todo) throw new Error(`no plan in ${planPath}`);
    const done = await scanShare(todo, { share: n - 1, shares: of });
    const file = arg('results', `results/${n}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(done));
    console.log(`share ${n} of ${of}: ${done.results.length} endpoints in ${done.seconds} s`);
    return;
  }
  if (mergeDir) {
    const todo = read(planPath);
    if (!todo) throw new Error(`no plan in ${planPath}`);
    const done = fs.existsSync(mergeDir) ? fs.readdirSync(mergeDir).filter((f) => f.endsWith('.json')).map((f) => read(path.join(mergeDir, f))).filter((d) => d?.results) : [];
    if (!done.length) throw new Error(`no finished share in ${mergeDir}`);
    merge(todo, done, { out });
    return;
  }
  const todo = await plan({ out, limit: Number(arg('limit', 0)) });
  if (planPath) {
    fs.mkdirSync(path.dirname(path.resolve(planPath)), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify(todo));
    const all = [...todo.resources, ...todo.added];
    console.log(`plan: ${all.length} endpoints on ${new Set(all.map(hostOf)).size} hosts`);
    return;
  }
  merge(todo, [await scanShare(todo)], { out });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { merge };
