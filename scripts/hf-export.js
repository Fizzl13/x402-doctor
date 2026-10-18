#!/usr/bin/env node
// The Trust Index as an open dataset for Hugging Face (run by .github/workflows/hf-sync.yml after the daily scan)
//
//   node scripts/hf-export.js --index trust-data/index.json --categories trust-data/categories.json --out hf
//
// Writes, from the published trust-data files only (nothing is fetched or paid):
//   hf/data/endpoints.jsonl  every endpoint in today's scan: verdict, reasons, price, networks, category, 30-day record
//   hf/data/daily.csv        go / caution / no_go per day over the history in index.json
//   hf/README.md             the dataset card, with today's counts
'use strict';

const fs = require('fs');
const path = require('path');
const { groupServices, categoryOf, guessCategory, CATEGORIES } = require('../lib/services');
const { trackRecord } = require('../lib/trust-scan');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
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

function card({ date, rows, daily, sanctions }) {
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
- ai-agents
- agent-payments
- payments
- stablecoins
- usdc
- api
size_categories:
- 10K<n<100K
configs:
- config_name: endpoints
  data_files: data/endpoints.jsonl
- config_name: daily
  data_files: data/daily.csv
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

## How it is collected

- **Sources:** the CDP Bazaar, Circle's Agent Marketplace, the MPP directory, GoPlausible and other public x402 indexes.
- **The check:** each endpoint is called once a day without paying. Its 402 challenge is parsed and checked the way a paying agent would: a valid challenge, the price against the listing, the network and token, whether the payout address can receive (Solana token accounts, Algorand opt-in, XRP Ledger and Stellar trustlines), testnet-only offers, and OFAC screening of the payout address (${sanctions?.list || 'OFAC SDN'} list${sanctions?.published ? `, published ${sanctions.published}` : ''}). Nothing is paid.
- **Caveat:** a sudden jump usually means one large seller went down or changed, since one seller can list tens of thousands of endpoints.

## Use it

\`\`\`python
from datasets import load_dataset
endpoints = load_dataset("${process.env.HF_DATASET || 'fizzl/x402-trust-index'}", "endpoints", split="train")
\`\`\`

- One endpoint's live record: \`GET https://x402-doctor.fizzl.eu/api/trust?url=<endpoint>\` (free)
- Before paying an endpoint: \`GET https://x402-doctor.fizzl.eu/api/v1/preflight?url=<endpoint>\` ($0.001, go / caution / no_go)
- What the data shows: [x402 health report, October 2026](https://fizzl.eu/research/x402-health-october-2026/) · [x402 on Stellar](https://fizzl.eu/research/x402-stellar-october-2026/)
- The same files on GitHub: [Fizzl13/x402-doctor, trust-data branch](https://github.com/Fizzl13/x402-doctor/tree/trust-data)

## License and citation

CC BY 4.0: free to use, share and adapt with credit to "x402 Trust Index by x402 Doctor (fizzl.eu)". The descriptions are the sellers' own words.
`;
}

function main() {
  const index = readJson(arg('index', 'trust-data/index.json'));
  if (!index || !index.resources) { console.error('hf-export: no index.json'); process.exit(1); }
  const categories = readJson(arg('categories', 'trust-data/categories.json'))?.categories || {};
  const out = arg('out', 'hf');
  const rows = endpointRows(index, categories);
  const daily = dailyRows(index);
  fs.mkdirSync(path.join(out, 'data'), { recursive: true });
  fs.writeFileSync(path.join(out, 'data', 'endpoints.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'data', 'daily.csv'), ['date,go,caution,no_go,checked', ...daily.map((d) => `${d.date},${d.go},${d.caution},${d.no_go},${d.checked}`)].join('\n') + '\n');
  const date = (index.days || []).slice(-1)[0] || String(index.updated || '').slice(0, 10);
  fs.writeFileSync(path.join(out, 'README.md'), card({ date, rows, daily, sanctions: index.sanctions }));
  console.log(`hf-export: ${rows.length} endpoints, ${daily.length} days → ${out}`);
}

if (require.main === module) main();
module.exports = { endpointRows, dailyRows, card };
