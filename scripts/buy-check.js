#!/usr/bin/env node
// Buy-check (started by hand: .github/workflows/buy-check.yml): buys through Fizzl Buy (buy.fizzl.eu) end to end, the
// way an agent would, and reports per need whether a seller delivered, which one, what it was paid and how long it
// took. Pays $0.02 a purchase with the spot-buy wallet (SPOT_BUY_KEY); Fizzl Buy then pays the seller from its own
// wallet. These are our own purchases: lib/public-stats.js leaves them out of the public Fizzl Buy counts (by this user
// agent and by the wallet).
//
//   node scripts/buy-check.js [--n 10] [--dry]
//
// Without the key (or with --dry) it only asks for the price (an unpaid call that gets the 402) and pays nothing.

const fs = require('fs');
const { createSpotWallet } = require('../lib/spot-wallet');

const USER_AGENT = 'x402-doctor-buy-check/1.0 (+https://x402-doctor.fizzl.eu; our own end-to-end test purchases through Fizzl Buy)';
const PRICE_USD = 0.02;
const BASE = 'eip155:8453';
const MAX_N = 20;
// Everyday needs of an agent; each run takes the next n, so runs differ from day to day.
const NEEDS = [
  'Bitcoin price in USD right now',
  'Weather forecast for Amsterdam tomorrow',
  'Ethereum price in USD',
  'Search the web for news about the x402 payment protocol',
  'Current weather in New York',
  'USD to EUR exchange rate today',
  'Solana price in USD',
  'Latest crypto news headlines',
  'Weather in Tokyo today',
  'Crypto fear and greed index',
  'Ethereum gas price right now',
  'Top trending tokens on Base',
  'Summary of the Wikipedia article about the Eiffel Tower',
  'Current time in Singapore',
  'BTC perpetual futures funding rate',
  'Is github.com up right now',
  'Translate "good morning" into Spanish',
  'Weather forecast for London this weekend',
  'XRP price in USD',
  'Latest AI news headlines',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const host = (u) => { try { return new URL(u).host; } catch { return null; } };

function needsFor(n, now = Date.now()) {
  const start = Math.floor(now / 864e5) % NEEDS.length;
  return Array.from({ length: n }, (_, i) => NEEDS[(start + i) % NEEDS.length]);
}

// The price Fizzl Buy asks on Base, from the 402 of an unpaid call (in USDC base units, 6 decimals).
function basePrice(header) {
  const required = JSON.parse(Buffer.from(String(header || ''), 'base64').toString('utf8'));
  const base = (required.accepts || []).find((a) => a.network === BASE && a.scheme === 'exact');
  return base ? Number(base.amount ?? base.maxAmountRequired) : null;
}

async function main() {
  const url = process.env.BUY_CHECK_URL || 'https://buy.fizzl.eu/v1/buy';
  const n = Math.min(Math.max(parseInt(arg('n', process.env.BUY_CHECK_N || '10'), 10) || 10, 1), MAX_N);
  const key = process.env.SPOT_BUY_KEY;
  const dry = process.argv.includes('--dry') || !key;
  const needs = needsFor(n);
  const headers = { 'content-type': 'application/json', 'user-agent': USER_AGENT };

  const quote = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ need: needs[0] }), signal: AbortSignal.timeout(30000) });
  if (quote.status !== 402) throw new Error(`expected a 402 from ${url}, got ${quote.status}`);
  const amount = basePrice(quote.headers.get('payment-required'));
  if (amount == null) throw new Error('the 402 has no x402 "exact" option on Base');
  if (amount > PRICE_USD * 1e6) throw new Error(`Fizzl Buy asks $${amount / 1e6} on Base, more than $${PRICE_USD}: not buying`);
  console.log(`${url} asks $${amount / 1e6} on Base; ${n} needs; ${dry ? 'DRY RUN (nothing paid)' : 'LIVE'}`);
  if (dry) {
    needs.forEach((need) => console.log(`  would buy: ${need}`));
    return;
  }

  const wallet = createSpotWallet({ key, capUsd: PRICE_USD, rpc: process.env.BASE_RPC_URL || undefined });
  const before = await wallet.balance();
  console.log(`wallet ${wallet.address}: ${(before / 1e6).toFixed(2)} USDC on Base`);
  if (before < n * amount) throw new Error(`the wallet holds $${(before / 1e6).toFixed(2)}, less than ${n} purchases of $${amount / 1e6}`);

  const rows = [];
  for (const need of needs) {
    const started = Date.now();
    let status;
    let body = null;
    try {
      const res = await wallet.payFetch(url, { method: 'POST', headers, body: JSON.stringify({ need }), signal: AbortSignal.timeout(150000) });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (err) {
      status = 'error';
      body = { error: err.message };
    }
    const row = {
      need,
      status,
      delivered: body?.delivered === true,
      seller: host(body?.service?.url),
      paid_to_seller_usd: body?.paid_usd ?? null,
      tried: body?.tried ?? null,
      what_was_paid_for: body?.answer_check?.delivered?.verdict ?? null,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      ...(body?.error ? { error: String(body.error).slice(0, 160) } : {}),
    };
    rows.push(row);
    console.log(`${row.delivered ? 'delivered' : 'not delivered'} ${row.status} ${row.seller ?? '-'} $${row.paid_to_seller_usd ?? '-'} ${row.seconds}s  ${need}${row.error ? `  (${row.error})` : ''}`);
  }
  const after = await wallet.balance();
  const delivered = rows.filter((r) => r.delivered).length;
  const out = {
    date: new Date().toISOString(),
    url,
    price_usd: amount / 1e6,
    bought: rows.length,
    delivered,
    sellers: new Set(rows.map((r) => r.seller).filter(Boolean)).size,
    spent_usd: Math.round(before - after) / 1e6,
    balance_usd: after / 1e6,
    rows,
  };
  fs.writeFileSync('buy-check.json', JSON.stringify(out, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Fizzl Buy buy-check: ${delivered} of ${rows.length} delivered`,
      '',
      `Spent $${out.spent_usd} from the spot-buy wallet (balance $${out.balance_usd.toFixed(2)}); ${out.sellers} different sellers. Our own purchases: left out of the public Fizzl Buy counts.`,
      '',
      '| Need | Delivered | Seller | Paid to seller | Tried | What was paid for (Jev) | Seconds |',
      '|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.need} | ${r.delivered ? 'yes' : `no (${r.status})`} | ${r.seller ?? ''} | ${r.paid_to_seller_usd ?? ''} | ${r.tried ?? ''} | ${r.what_was_paid_for ?? ''} | ${r.seconds} |`),
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  if (!delivered) throw new Error('no purchase delivered: Fizzl Buy may be broken');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
module.exports = { needsFor, basePrice, NEEDS, USER_AGENT };
