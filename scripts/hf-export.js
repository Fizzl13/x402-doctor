#!/usr/bin/env node
// The Trust Index as an open dataset for Hugging Face (run by .github/workflows/hf-sync.yml after the daily scan)
//
//   node scripts/hf-export.js --index trust-data/index.json --categories trust-data/categories.json --out hf
//
// Writes, from the published trust-data files only (nothing is fetched or paid):
//   hf/data/endpoints.jsonl  every endpoint in today's scan: verdict, reasons, price, networks, category, 30-day record
//   hf/data/daily.csv        go / caution / no_go per day over the history in index.json
//   hf/data/spot_buys.jsonl  every purchase of the weekly spot-buy (--spot: the spot-data branch's results/ folder)
//   hf/data/onchain_payments.csv  x402 payments per payout address per day on Base, Solana, the XRP Ledger, Stellar and Algorand
//                            (--payments: payments.json, and the other networks' files, comma-separated)
//   hf/README.md             the dataset card, with today's counts
'use strict';

const fs = require('fs');
const path = require('path');
const { groupServices, categoryOf, guessCategory, CATEGORIES } = require('../lib/services');
const { trackRecord } = require('../lib/trust-scan');
const { readIndexFile } = require('../lib/index-files');
const { viewOf } = require('../lib/spot-results');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readIndex = (file) => { try { return readIndexFile(file); } catch { return null; } };
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return null; } };

// One row per endpoint that was in today's scan (its history's last day isn't '-').
function endpointRows(index, categories) {
  const grouped = groupServices(index.resources);
  const rows = [];
  for (const entry of Object.values(index.resources || {})) {
    const h = entry.h || '';
    if (!entry.last || h.slice(-1) === '-' || !h) continue;
    const service = grouped.byUrl.get(entry.url);
    const record = trackRecord(h);
    rows.push({
      url: entry.url,
      host: hostOf(entry.url),
      method: entry.m || 'GET',
      protocol: entry.p === 'mpp' ? 'mpp' : 'x402',
      verdict: entry.last.verdict,
      reasons: entry.last.codes || [],
      price_usd: entry.last.price_usd ?? null,
      networks: (entry.last.networks || []).filter((n) => typeof n === 'string'),
      unpayable_networks: Object.keys(entry.last.unpayable || {}),
      category: service ? categoryOf(service, categories) : guessCategory(entry.d || entry.url),
      same_service_endpoints: service ? service.members.length : 1,
      days_checked: record ? record.days_checked : 0,
      days_payable: record ? record.days_payable : 0,
      payable_ratio: record ? record.payable_ratio : null,
      history: h,
      description: (entry.d || '').slice(0, 300),
    });
  }
  return rows.sort((a, b) => a.url.localeCompare(b.url));
}

// go / caution / no_go per day, from each endpoint's history (one letter per day in index.days).
function dailyRows(index) {
  const days = index.days || [];
  return days.map((date, i) => {
    const c = { g: 0, c: 0, n: 0 };
    for (const entry of Object.values(index.resources || {})) {
      const letter = (entry.h || '')[i];
      if (letter in c) c[letter]++;
    }
    return { date, go: c.g, caution: c.c, no_go: c.n, checked: c.g + c.c + c.n };
  });
}

// Every live spot-buy purchase, from the run files (results/<date>.json, a second run that day <date>-2.json).
function spotRows(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const view = viewOf(readJson(path.join(dir, name)));
    for (const p of view?.purchases || []) {
      rows.push({ date: p.date, run: name.replace(/\.json$/, ''), url: p.url, host: p.host, result: p.result, price_usd: p.price_usd, charged_usd: p.charged_usd, status: p.status, reason: p.reason ?? null, answer_s: p.answer_s, timed_out: Boolean(p.timed_out), request: p.request });
    }
  }
  return rows;
}

// x402 payments per payout address and day (lib/onchain-payments.js and its Solana, XRP Ledger, Stellar and Algorand
// counterparts, all the same shape), with how much of the day was read: Base counts blocks (43,200 a day), the others
// mark a day read (per_day 1). Base's file names no network.
function paymentRows(...states) {
  const rows = [];
  for (const state of states) {
    if (state?.version !== 1) continue;
    const network = state.network || 'eip155:8453';
    const perDay = state.per_day || 43200;
    for (const [payTo, entry] of Object.entries(state.pay_tos || {})) {
      for (const [date, d] of Object.entries(entry.d || {})) {
        if (!d[0]) continue; // a day with only USDC sent out (closed-loop check), no payment in
        rows.push({ date, pay_to: payTo, payments: d[0], usd: Math.round(d[1] / 1e4) / 100, payers: d[2].length, day_coverage: Math.min(1, Math.round(((state.days?.[date]?.covered || 0) / perDay) * 1000) / 1000), network });
      }
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.network.localeCompare(b.network) || b.payments - a.payments || a.pay_to.localeCompare(b.pay_to));
}

function card({ date, rows, daily, sanctions, spot = [], payments = [] }) {
  const payable = rows.filter((r) => r.verdict === 'go' || r.verdict === 'caution').length;
  const pct = rows.length ? Math.round((1000 * payable) / rows.length) / 10 : 0;
  const first = daily.find((d) => d.checked > 0)?.date || date;
  return `---
license: cc-by-4.0
pretty_name: x402 Trust Index
language:
- en
tags:
- x402
- mpp
- http-402
- ai-agents
- agent-payments
- payments
- stablecoins
- usdc
- base
- solana
- api
- monitoring
size_categories:
- 10K<n<100K
configs:
- config_name: endpoints
  data_files: data/endpoints.jsonl
- config_name: daily
  data_files: data/daily.csv${spot.length ? `
- config_name: spot_buys
  data_files: data/spot_buys.jsonl` : ''}${payments.length ? `
- config_name: onchain_payments
  data_files: data/onchain_payments.csv` : ''}
---

# x402 Trust Index

Every paid x402 and MPP API endpoint that public indexes list, checked once a day the way a paying AI agent would: can an agent pay it today, at the advertised price, to an address that can receive, and how often could it over the last ${daily.length} days. Built by [x402 Doctor](https://x402-doctor.fizzl.eu) (Fizzl).

Scan of **${date}**: ${rows.length.toLocaleString('en-US')} endpoints, ${payable.toLocaleString('en-US')} (${pct}%) payable as listed. Daily history since ${first}. Updated after every daily scan.

## Files

- \`data/endpoints.jsonl\`, one row per endpoint in the latest scan:
  - \`url\`, \`host\`, \`method\`, \`protocol\` (\`x402\` or \`mpp\`)
  - \`verdict\`: \`go\` (payable as listed), \`caution\` (payable, with a detail some clients refuse) or \`no_go\` (an agent should not pay it)
  - \`reasons\`: the check codes behind the verdict, such as \`no_402\`, \`resource_mismatch\`, \`testnet_only\`, \`price_above_advertised\` or \`payto_sanctioned\`
  - \`price_usd\`: the cheapest payable price per call
  - \`networks\`: the CAIP-2 networks the endpoint can be paid on today; \`unpayable_networks\`: networks it offers but that can't be paid (for example a Stellar asset given as text)
  - \`category\`: the kind of service (${CATEGORIES.map((c) => c.id).join(', ')}), from TypeSafe Jev or a keyword guess
  - \`same_service_endpoints\`: how many of the seller's endpoints are the same service (one per coin, city or ticker)
  - \`days_checked\`, \`days_payable\`, \`payable_ratio\`, and \`history\`: one letter per day, oldest first (\`g\` go, \`c\` caution, \`n\` no_go, \`x\` error, \`-\` not listed that day)
  - \`description\`: the seller's own description, cut at 300 characters
- \`data/daily.csv\`: \`date, go, caution, no_go, checked\` for every day in the history.
${spot.length ? `- \`data/spot_buys.jsonl\`: what came back when x402 Doctor actually paid. Every week it buys a random sample of up to 30 endpoints that are \`go\` here (one per seller, at most $0.05 each, USDC on Base, from a dedicated wallet) with the example input from the seller's own listing. ${spot.length} purchases so far:
  - \`date\`, \`run\`, \`url\`, \`host\`, \`price_usd\`, \`charged_usd\` (measured on chain)
  - \`result\`: \`delivered\`, \`off_schema\` (an answer that doesn't match the declared schema), \`empty\`, \`charged_not_delivered\`, \`payment_rejected\` (asked to pay again, not charged), \`error_not_charged\` or \`payment_failed\`
  - \`status\`, \`reason\`, \`answer_s\` (seconds from the first request to the paid answer), \`timed_out\`, \`request\` (\`example\`: the listing's own example input)
` : ''}${payments.length ? `- \`data/onchain_payments.csv\`: real payments. Per payout address and per UTC day (the last 8): \`date, pay_to, payments, usd, payers\` (different paying wallets), \`day_coverage\` (the share of that day that was read) and \`network\` (CAIP-2). Only payments settled the way x402 settles count:
  - Base (\`eip155:8453\`): USDC that the payer signed with EIP-3009 (\`transferWithAuthorization\`), to the payout addresses in this index. Plain transfers, Permit2 and Circle Gateway batches don't count; x402 Doctor's own test wallet is left out.
  - Solana (USDC): transfers whose network fee a facilitator named in the sellers' offers paid (\`extra.feePayer\`), to the payout addresses in this index.
  - The XRP Ledger (\`xrpl:0\`, RLUSD or USDC): payments marked by an x402 client (t54's SourceTag 804681468, or @x402/xrpl's InvoiceID); a cashed Check of x402's batch settlement counts once. To the payout addresses in this index.
  - Stellar (\`stellar:pubnet\`, Circle's USDC): Soroban transfers that the payer authorized and a facilitator sent, to the payout addresses in this index and to the accounts the x402 facilitators (OpenZeppelin, agent402.tools) delivered USDC to.
  - Algorand (\`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=\`, USDC ASA 31566704): transfers in an atomic group whose fee another transaction paid (the facilitator's fee pooling), to the payout addresses in this index and to the addresses GoPlausible's facilitator settled payments for.
` : ''}
## How it is collected

- **Sources:** the CDP Bazaar, Circle's Agent Marketplace, the MPP directory, GoPlausible, the XRPL AI Hub, [nohumans.directory](https://nohumans.directory)'s catalogue (CC BY 4.0), [PayAPI Market](https://payapi.market) and other public x402 indexes.
- **The check:** each endpoint is called once a day without paying. Its 402 challenge is parsed and checked the way a paying agent would: a valid challenge, the price against the listing, the network and token, whether the payout address can receive (Solana token accounts, Algorand opt-in, XRP Ledger and Stellar trustlines), testnet-only offers, and OFAC screening of the payout address (${sanctions?.list || 'OFAC SDN'} list${sanctions?.published ? `, published ${sanctions.published}` : ''}). Nothing is paid.
- **Caveat:** a sudden jump usually means one large seller went down or changed, since one seller can list tens of thousands of endpoints.

## Use it

\`\`\`python
from datasets import load_dataset
endpoints = load_dataset("${process.env.HF_DATASET || 'fizzl/x402-trust-index'}", "endpoints", split="train")
\`\`\`

- One endpoint's live record: \`GET https://x402-doctor.fizzl.eu/api/trust?url=<endpoint>\` (free)
- Before paying an endpoint: \`GET https://x402-doctor.fizzl.eu/api/v1/preflight?url=<endpoint>\` ($0.001, go / caution / no_go)
- What the data shows: [x402 health report, October 2026](https://fizzl.eu/research/x402-health-october-2026/) · [The seven most common x402 seller mistakes](https://fizzl.eu/research/x402-seller-mistakes-october-2026/) · [x402 on Stellar](https://fizzl.eu/research/x402-stellar-october-2026/) · [Circle's Agent Marketplace](https://fizzl.eu/research/circle-agent-marketplace-october-2026/)
- What the on-chain payments show: [Half the x402 sellers paid on Base were paid only by scanners](https://fizzl.eu/research/x402-real-buyers-october-2026/) · [x402 runs on cents, but the money comes from a few big payments](https://fizzl.eu/research/x402-where-the-money-goes-october-2026/) · [x402 on the XRP Ledger](https://fizzl.eu/research/x402-xrpl-october-2026/) · [x402 on Stellar: 398 payments, $3.93](https://fizzl.eu/research/x402-stellar-payments-october-2026/)
- Who gets paid, live: [XRP Ledger](https://x402-doctor.fizzl.eu/xrpl) · [Stellar](https://x402-doctor.fizzl.eu/stellar) · all of our open x402 data: [the x402 agent payments collection](https://huggingface.co/collections/x402Fizzl/x402-agent-payments-6ad62101ba3cdbcf5f990a0e)
- How AI agents handle payment traps: [x402 Agent Safety Bench](https://fizzl.eu/bench/)
- Security, from the price column: [x402's critical SDK flaws (V12, Oct 2026)](https://fizzl.eu/research/x402-sdk-flaws-v12-october-2026/): how many endpoints ask more than the new $1 default cap, and what a check outside the agent stops · [The zod advisory in every x402 project](https://fizzl.eu/research/x402-zod-advisory-october-2026/)
- The same files on GitHub: [Fizzl13/x402-doctor, trust-data branch](https://github.com/Fizzl13/x402-doctor/tree/trust-data)

## License and citation

CC BY 4.0: free to use, share and adapt with credit to "x402 Trust Index by x402 Doctor (fizzl.eu)". The descriptions are the sellers' own words.
`;
}

function main() {
  const index = readIndex(arg('index', 'trust-data/index.json'));
  if (!index || !index.resources) { console.error('hf-export: no index.json'); process.exit(1); }
  const categories = readJson(arg('categories', 'trust-data/categories.json'))?.categories || {};
  const out = arg('out', 'hf');
  const rows = endpointRows(index, categories);
  const daily = dailyRows(index);
  fs.mkdirSync(path.join(out, 'data'), { recursive: true });
  fs.writeFileSync(path.join(out, 'data', 'endpoints.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'data', 'daily.csv'), ['date,go,caution,no_go,checked', ...daily.map((d) => `${d.date},${d.go},${d.caution},${d.no_go},${d.checked}`)].join('\n') + '\n');
  const date = (index.days || []).slice(-1)[0] || String(index.updated || '').slice(0, 10);
  const spot = spotRows(arg('spot', null));
  if (spot.length) fs.writeFileSync(path.join(out, 'data', 'spot_buys.jsonl'), spot.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const payments = paymentRows(...String(arg('payments', '')).split(',').filter(Boolean).map(readJson));
  if (payments.length) fs.writeFileSync(path.join(out, 'data', 'onchain_payments.csv'), ['date,pay_to,payments,usd,payers,day_coverage,network', ...payments.map((p) => `${p.date},${p.pay_to},${p.payments},${p.usd},${p.payers},${p.day_coverage},${p.network}`)].join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'README.md'), card({ date, rows, daily, sanctions: index.sanctions, spot, payments }));
  console.log(`hf-export: ${rows.length} endpoints, ${daily.length} days, ${spot.length} spot-buy purchases, ${payments.length} payment rows → ${out}`);
}

if (require.main === module) main();
module.exports = { endpointRows, dailyRows, spotRows, paymentRows, card };
