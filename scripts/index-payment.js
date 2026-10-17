#!/usr/bin/env node
// Payments to our own routes, so the CDP Bazaar lists them (run by .github/workflows/index-payment.yml).
//
//   node scripts/index-payment.js --url https://presign-guard.fizzl.eu/v1/screen?address=... [--dry]
//   node scripts/index-payment.js --stale [--days 21] [--dry]
//
// The Bazaar lists a route only once a payment for it has settled through the CDP facilitator, and drops it after 30
// days without one; directories that read the Bazaar (Roundhouse, our own Trust Index) follow it. --url makes one
// such payment; --stale pays each of our routes (INDEX_PAYMENT.routes in lib/spot-buy.js) whose last settled payment
// in the Bazaar is --days old or more (default 21), or that the Bazaar does not list. Each payment costs at most the
// route's own cap (its price; any other fizzl.eu URL $0.01), only to a fizzl.eu route, with the spot-buy wallet
// (SPOT_BUY_KEY), and goes to our own payout wallet. It takes the same steps as a spot-buy purchase (a fresh
// preflight with the OFAC screen of the payout address, the charge measured on chain) but publishes nothing, so the
// spot-buy results stay a sample of other sellers.
// Without the key (or with --dry) it does everything up to the payment and pays nothing.
// A self-audit too, on our own routes only: each paid request's payment is sent once more and must get a 402 ("Five
// Attacks on x402", attack II: one payment, two answers), and the settlement transaction must carry our Base
// Builder Code (ERC-8021), so Base attributes the payment to us.

const fs = require('fs');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createSanctions } = require('../lib/sanctions');
const { checkSettlement } = require('../lib/settlement');
const { createSpotWallet } = require('../lib/spot-wallet');
const { runSpotBuy, ownTarget, INDEX_PAYMENT, indexCapFor, staleRoutes, BASE } = require('../lib/spot-buy');
const { NETWORKS } = require('../lib/networks');
const { parseBuilderCodeSuffixFromCalldata } = require('@x402/extensions/builder-code');

const SEARCH = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';

// Our routes as the Bazaar lists them, with their last settled payment: one search per host (read-only, no key).
async function listedRoutes(routes) {
  const hosts = [...new Set(routes.map((r) => new URL(r.url).hostname))];
  const listed = [];
  for (const host of hosts) {
    const res = await fetch(`${SEARCH}?query=${encodeURIComponent(host)}&limit=20`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Bazaar search HTTP ${res.status} for ${host}`);
    const found = ((await res.json()).resources || []).filter((r) => typeof r.resource === 'string' && new URL(r.resource).hostname === host);
    // A host without a single listed route most likely means the search failed: never pay all of them on that.
    if (!found.length) throw new Error(`the Bazaar search found no route of ${host}: not paying on that`);
    listed.push(...found);
  }
  return listed;
}

// The ERC-8021 builder codes in a Base transaction's calldata: { a, w, s } as the facilitator wrote them, null when
// it carries none, undefined when the transaction could not be read.
async function attribution(tx, rpc) {
  try {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [tx] }), signal: AbortSignal.timeout(15000) });
    const input = (await res.json()).result?.input;
    return input ? parseBuilderCodeSuffixFromCalldata(input) ?? null : undefined;
  } catch {
    return undefined;
  }
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const key = process.env.SPOT_BUY_KEY;
  const dry = process.argv.includes('--dry') || !key;
  const { userAgent } = INDEX_PAYMENT;
  let targets;
  if (process.argv.includes('--stale')) {
    const staleDays = Number(arg('days') || INDEX_PAYMENT.staleDays);
    if (!(staleDays >= 7)) throw new Error('--days must be 7 or more');
    const due = staleRoutes(await listedRoutes(INDEX_PAYMENT.routes), { staleDays });
    for (const r of INDEX_PAYMENT.routes) {
      const d = due.find((x) => x.url === r.url);
      console.log(`${d ? 'DUE ' : 'ok  '} ${r.url}${d ? ` (${d.listed ? `last settled ${d.last_settled}, ${d.age_days} days ago` : 'not listed'})` : ''}`);
    }
    targets = due.map((d) => ownTarget(d.url));
  } else {
    const target = ownTarget(arg('url') || '');
    if (!target) throw new Error('--url must be an https URL on a fizzl.eu host');
    targets = [target];
  }
  const totalUsd = targets.reduce((sum, t) => sum + indexCapFor(t), 0);
  console.log(`${targets.length} route(s) to pay, at most $${totalUsd.toFixed(3)} in all, ${dry ? 'DRY RUN' : 'LIVE'}`);
  if (!targets.length) return;

  const sanctions = createSanctions();
  const list = await sanctions.ready({ waitMs: 30000 });
  if (!list) throw new Error(`OFAC list unavailable (${sanctions.status().lastError ?? 'timeout'}): not paying without the payout screen`);

  let wallet = null;
  if (!dry) {
    // Each payment is held to its own route's cap below; the wallet's own ceiling is the largest of them.
    wallet = createSpotWallet({ key, capUsd: Math.max(...targets.map(indexCapFor)), rpc: process.env.BASE_RPC_URL || undefined });
    const start = await wallet.balance();
    console.log(`wallet ${wallet.address}: ${(start / 1e6).toFixed(2)} USDC on Base`);
  }

  const rows = [];
  let failed = 0;
  for (const target of targets) {
    const capUsd = indexCapFor(target);
    const { results } = await runSpotBuy([target], {
      safeFetch: createSafeFetch({ allowPrivate: false, timeoutMs: 15000 }),
      payFetch: wallet?.payFetch ?? null,
      sanctions,
      balance: wallet ? wallet.balance : async () => null,
      settlement: (header) => checkSettlement(header, { rpcUrls: process.env.BASE_RPC_URL ? { [BASE]: process.env.BASE_RPC_URL } : {} }),
      capUsd,
      budgetUsd: capUsd,
      userAgent,
      ownRoutesOnly: true,
      lastPayment: wallet?.lastPayment ?? null,
    });
    const r = results[0];
    if (r.proof?.transaction) {
      const codes = await attribution(r.proof.transaction, process.env.BASE_RPC_URL || NETWORKS[BASE].rpc);
      if (codes !== undefined) r.builder_code = codes;
    }
    console.log(JSON.stringify(r, null, 2));
    // A route that serves the same payment twice fails the run: that is a hole in our own paywall.
    const ok = dry ? r.result === 'would_buy' : (r.result === 'delivered' || r.result === 'off_schema') && !r.replay?.served;
    if (!ok) failed++;
    const replay = r.replay ? (r.replay.served ? `⚠️ served again (${r.replay.status})` : `refused (${r.replay.status ?? r.replay.error})`) : '';
    const code = r.builder_code === undefined ? '' : r.builder_code?.a ? `${r.builder_code.a}${r.builder_code.w ? ` (w ${r.builder_code.w})` : ''}` : 'none';
    rows.push(`| ${r.request?.url ?? r.url} | ${r.result} | ${r.price_usd ?? ''} | ${r.charged_usd ?? ''} | ${replay} | ${code} | ${r.proof?.explorer || r.proof?.transaction || ''} |`);
    if (r.result === 'wallet_empty') { console.log('the wallet is out of funds: the rest is not paid'); break; }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Index payment (${dry ? 'dry run, nothing paid' : 'live'})`, '',
      `| Route | Result | Price | Charged | Same payment again | Builder Code | Transaction |`, '|---|---|---|---|---|---|---|', ...rows,
      '', !failed && !dry ? 'The CDP Bazaar lists a route after its settlement; directories that read it follow within a day.' : '',
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
