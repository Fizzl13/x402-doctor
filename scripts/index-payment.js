#!/usr/bin/env node
// One payment to one of our own routes, so the CDP Bazaar lists it (run by .github/workflows/index-payment.yml).
//
//   node scripts/index-payment.js --url https://presign-guard.fizzl.eu/v1/screen?address=... [--dry]
//
// The Bazaar lists a route only once a payment for it has settled through the CDP facilitator, and directories that
// read the Bazaar (Roundhouse, our own Trust Index) find the route only then. This makes that payment: one call, at
// most $0.01 in USDC on Base, only to a fizzl.eu route, with the spot-buy wallet (SPOT_BUY_KEY). It takes the same
// steps as a spot-buy purchase (a fresh preflight with the OFAC screen of the payout address, the charge measured on
// chain) but publishes nothing, so the spot-buy results stay a sample of other sellers.
// Without the key (or with --dry) it does everything up to the payment and pays nothing.

const fs = require('fs');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createSanctions } = require('../lib/sanctions');
const { checkSettlement } = require('../lib/settlement');
const { createSpotWallet } = require('../lib/spot-wallet');
const { runSpotBuy, ownTarget, INDEX_PAYMENT, BASE } = require('../lib/spot-buy');

async function main() {
  const i = process.argv.indexOf('--url');
  const target = ownTarget(i > 0 ? process.argv[i + 1] : '');
  if (!target) throw new Error('--url must be an https URL on a fizzl.eu host');
  const key = process.env.SPOT_BUY_KEY;
  const dry = process.argv.includes('--dry') || !key;
  const { capUsd, userAgent } = INDEX_PAYMENT;
  console.log(`${target.url}: at most $${capUsd}, ${dry ? 'DRY RUN' : 'LIVE'}`);

  const sanctions = createSanctions();
  const list = await sanctions.ready({ waitMs: 30000 });
  if (!list) throw new Error(`OFAC list unavailable (${sanctions.status().lastError ?? 'timeout'}): not paying without the payout screen`);

  let wallet = null;
  if (!dry) {
    wallet = createSpotWallet({ key, capUsd, rpc: process.env.BASE_RPC_URL || undefined });
    const start = await wallet.balance();
    console.log(`wallet ${wallet.address}: ${(start / 1e6).toFixed(2)} USDC on Base`);
  }

  const { results } = await runSpotBuy([target], {
    safeFetch: createSafeFetch({ allowPrivate: false, timeoutMs: 15000 }),
    payFetch: wallet?.payFetch ?? null,
    sanctions,
    balance: wallet ? wallet.balance : async () => null,
    settlement: (header) => checkSettlement(header, { rpcUrls: process.env.BASE_RPC_URL ? { [BASE]: process.env.BASE_RPC_URL } : {} }),
    capUsd,
    budgetUsd: capUsd,
    userAgent,
  });
  const r = results[0];
  console.log(JSON.stringify(r, null, 2));
  const ok = dry ? r.result === 'would_buy' : r.result === 'delivered' || r.result === 'off_schema';
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Index payment (${dry ? 'dry run, nothing paid' : 'live'})`, '',
      `| Route | Result | Price | Charged | Transaction |`, '|---|---|---|---|---|',
      `| ${r.request?.url ?? r.url} | ${r.result} | ${r.price_usd ?? ''} | ${r.charged_usd ?? ''} | ${r.proof?.explorer || r.proof?.transaction || ''} |`,
      '', ok && !dry ? 'The CDP Bazaar lists the route after this settlement; directories that read it follow within a day.' : '',
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
