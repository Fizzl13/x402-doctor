#!/usr/bin/env node
// Hourly: reads the Base blocks since the last run and counts the signed USDC payments (EIP-3009) to every payout
// address the daily Trust Index scan saw (paytos.json on the trust-data branch). Writes payments.json; the workflow
// publishes it on the payments-data branch. With --sol-paytos it also reads the Solana payout addresses' new
// transactions (paytos-solana.json) and writes payments-solana.json, and with --xrpl-paytos the same for the XRP
// Ledger (paytos-xrpl.json, payments-xrpl.json), with --stellar-paytos for Stellar (paytos-stellar.json,
// payments-stellar.json), and with --algorand-paytos for Algorand (paytos-algorand.json, payments-algorand.json). Read-only: it never pays and holds no key.
//
//   node scripts/onchain-payments.js --state payments-data/payments.json --paytos paytos.json \
//     --sol-state payments-data/payments-solana.json --sol-paytos paytos-solana.json \
//     --xrpl-state payments-data/payments-xrpl.json --xrpl-paytos paytos-xrpl.json \
//     --stellar-state payments-data/payments-stellar.json --stellar-paytos paytos-stellar.json \
//     --algorand-state payments-data/payments-algorand.json --algorand-paytos paytos-algorand.json
//
// BASE_RPC_URL (optional) is asked first; the public node serves only the last ~10,000 blocks, so with it alone a
// gap of more than ~5 hours between runs shows up as lower coverage. SOLANA_RPC_URL (optional) is asked before
// Solana's public node, which allows one call a second per method. XRPL_RPC_URL (optional) is asked before the public
// XRPL nodes, STELLAR_HORIZON_URL (optional) before horizon.stellar.org, ALGORAND_INDEXER_URL (optional) before
// AlgoNode's public indexer.

const fs = require('node:fs');
const { collect, totalsOf, PUBLIC_RPC } = require('../lib/onchain-payments');
const { collectSolana, PUBLIC_RPC: SOLANA_PUBLIC_RPC } = require('../lib/onchain-payments-solana');
const { collectXrpl, PUBLIC_NODES: XRPL_PUBLIC_NODES } = require('../lib/onchain-payments-xrpl');
const { collectStellar, PUBLIC_HORIZON } = require('../lib/onchain-payments-stellar');
const { collectAlgorand, PUBLIC_INDEXER } = require('../lib/onchain-payments-algorand');

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
  // A keyed node can go faster than the public one, which allows 10 calls of one method per 10 seconds.
  const pace = keyed ? { minGapMs: 120 } : { minGapMs: 350, methodGapMs: 1100 };
  const state = await collectSolana(read(statePath), { payTos, feePayers: Object.keys(list.fee_payers || {}), nodes, ...pace, log: (line) => console.log(`Solana: ${line}`) });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(`Solana: ${payTos.length} payout addresses watched; last 7 days: ${JSON.stringify(totalsOf(state))}`);
}

async function xrpl() {
  const listPath = arg('xrpl-paytos', null);
  if (!listPath) return;
  const statePath = arg('xrpl-state', 'payments-data/payments-xrpl.json');
  const payTos = Object.keys(read(listPath)?.pay_tos || {});
  if (!payTos.length) {
    console.log('no payout addresses on the XRP Ledger yet (paytos-xrpl.json comes with the next Trust Index scan); nothing to do');
    return;
  }
  const nodes = [process.env.XRPL_RPC_URL?.trim(), ...XRPL_PUBLIC_NODES].filter(Boolean);
  const state = await collectXrpl(read(statePath), { payTos, nodes, log: (line) => console.log(`XRPL: ${line}`) });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(`XRPL: ${payTos.length} payout addresses watched; last 7 days: ${JSON.stringify(totalsOf(state))}`);
}

async function stellar() {
  const listPath = arg('stellar-paytos', null);
  if (!listPath) return;
  const statePath = arg('stellar-state', 'payments-data/payments-stellar.json');
  const payTos = Object.keys(read(listPath)?.pay_tos || {});
  if (!payTos.length) {
    console.log('no payout accounts on Stellar yet (paytos-stellar.json comes with the next Trust Index scan); nothing to do');
    return;
  }
  const nodes = [process.env.STELLAR_HORIZON_URL?.trim(), PUBLIC_HORIZON].filter(Boolean);
  const state = await collectStellar(read(statePath), { payTos, nodes, log: (line) => console.log(`Stellar: ${line}`) });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(`Stellar: ${payTos.length} payout accounts watched; last 7 days: ${JSON.stringify(totalsOf(state))}`);
}

async function algorand() {
  const listPath = arg('algorand-paytos', null);
  if (!listPath) return;
  const statePath = arg('algorand-state', 'payments-data/payments-algorand.json');
  // Without paytos-algorand.json yet (it comes with the next Trust Index scan), the facilitator's addresses still count.
  const payTos = Object.keys(read(listPath)?.pay_tos || {});
  const nodes = [process.env.ALGORAND_INDEXER_URL?.trim(), PUBLIC_INDEXER].filter(Boolean);
  const state = await collectAlgorand(read(statePath), { payTos, nodes, log: (line) => console.log(`Algorand: ${line}`) });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(`Algorand: ${Object.keys(state.pay_tos).length} payout addresses watched (${payTos.length} from the scan); last 7 days: ${JSON.stringify(totalsOf(state))}`);
}

async function main() {
  // Base first: it is the established count, and a Solana, XRPL, Stellar or Algorand problem must not hold it up.
  await base();
  await solana().catch((err) => console.error('Solana:', err));
  await xrpl().catch((err) => console.error('XRPL:', err));
  await stellar().catch((err) => console.error('Stellar:', err));
  await algorand().catch((err) => console.error('Algorand:', err));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
