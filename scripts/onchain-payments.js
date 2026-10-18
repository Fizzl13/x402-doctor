#!/usr/bin/env node
// Hourly: reads the Base blocks since the last run and counts the signed USDC payments (EIP-3009) to every payout
// address the daily Trust Index scan saw (paytos.json on the trust-data branch). Writes payments.json; the workflow
// publishes it on the payments-data branch. Read-only: it never pays and holds no key.
//
//   node scripts/onchain-payments.js --state payments-data/payments.json --paytos paytos.json
//
// BASE_RPC_URL (optional) is asked first; the public node serves only the last ~10,000 blocks, so with it alone a
// gap of more than ~5 hours between runs shows up as lower coverage.

const fs = require('node:fs');
const { collect, totalsOf, PUBLIC_RPC } = require('../lib/onchain-payments');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const statePath = arg('state', 'payments-data/payments.json');
  const payTosPath = arg('paytos', 'paytos.json');
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const payTos = Object.keys(read(payTosPath)?.pay_tos || {});
  if (!payTos.length) {
    console.log('no payout addresses yet (paytos.json comes with the next Trust Index scan); nothing to do');
    return;
  }
  const nodes = [process.env.BASE_RPC_URL?.trim(), PUBLIC_RPC].filter(Boolean);
  const state = await collect(read(statePath), { payTos, nodes, log: (line) => console.log(line) });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(`${payTos.length} payout addresses watched; last 7 days: ${JSON.stringify(totalsOf(state))}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
