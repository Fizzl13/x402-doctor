#!/usr/bin/env node
// Hourly: reads the Base blocks since the last run and counts the signed USDC payments (EIP-3009) to every payout
// address the daily Trust Index scan saw (paytos.json on the trust-data branch). Writes payments.json; the workflow
// publishes it on the payments-data branch. With --sol-paytos it also reads the Solana payout addresses' new
// transactions (paytos-solana.json) and writes payments-solana.json. Read-only: it never pays and holds no key.
//
//   node scripts/onchain-payments.js --state payments-data/payments.json --paytos paytos.json \
//     --sol-state payments-data/payments-solana.json --sol-paytos paytos-solana.json
//
// BASE_RPC_URL (optional) is asked first; the public node serves only the last ~10,000 blocks, so with it alone a
// gap of more than ~5 hours between runs shows up as lower coverage. SOLANA_RPC_URL (optional) is asked before
// Solana's public node, which allows only a few calls a second.

const fs = require('node:fs');
const { collect, totalsOf, PUBLIC_RPC } = require('../lib/onchain-payments');
const { collectSolana, PUBLIC_RPC: SOLANA_PUBLIC_RPC } = require('../lib/onchain-payments-solana');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

async function base() {
  const statePath = arg('state', 'payments-data/payments.json');
  const payTos = Object.keys(read(arg('paytos', 'paytos.json'))?.pay_tos || {});
  if (!payTos.length) {
    console.log('no payout addresses on Base yet (paytos.json comes with the next Trust Index scan); nothing to do');
    return;
  }
  const nodes = [process.env.BASE_RPC_URL?.trim(), PUBLIC_RPC].filter(Boolean);
  const state = await collect(read(statePath), { payTos, nodes, log: (line) => console.log(line) });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(`Base: ${payTos.length} payout addresses watched; last 7 days: ${JSON.stringify(totalsOf(state))}`);
}

async function solana() {
  const listPath = arg('sol-paytos', null);
  if (!listPath) return;
  const statePath = arg('sol-state', 'payments-data/payments-solana.json');
  const list = read(listPath);
  const payTos = Object.keys(list?.pay_tos || {});
  if (!payTos.length) {
    console.log('no payout addresses on Solana yet (paytos-solana.json comes with the next Trust Index scan); nothing to do');
    return;
  }
  const keyed = Boolean(process.env.SOLANA_RPC_URL?.trim());
  const nodes = [process.env.SOLANA_RPC_URL?.trim(), SOLANA_PUBLIC_RPC].filter(Boolean);
  // A keyed node can go faster than the public one.
  const state = await collectSolana(read(statePath), { payTos, feePayers: Object.keys(list.fee_payers || {}), nodes, minGapMs: keyed ? 120 : 350, log: (line) => console.log(`Solana: ${line}`) });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(`Solana: ${payTos.length} payout addresses watched; last 7 days: ${JSON.stringify(totalsOf(state))}`);
}

async function main() {
  // Base first: it is the established count, and a Solana problem must not hold it up.
  await base();
  await solana().catch((err) => console.error('Solana:', err));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
