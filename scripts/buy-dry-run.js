#!/usr/bin/env node
// What Fizzl Buy (buy-server.js) would do for one or more needs, without paying: the candidates from the catalog
// search, the request Claude fills in for each, and a fresh preflight (the 402, the price, go or not). Needs
// ANTHROPIC_API_KEY (the filler); TYPESAFE_API_KEY adds the bait check to the preflight.
//   node scripts/buy-dry-run.js "weather forecast Amsterdam tomorrow" "BTC price in USD"
'use strict';

const { candidatesFor } = require('../lib/buy/search');
const { createFiller } = require('../lib/buy/fill');
const { preflight } = require('../lib/preflight');
const { createSafeFetch } = require('../lib/safe-fetch');
const { createLure } = require('../lib/jev-lure');
const { MAX_TRIES } = require('../lib/buy/purchase');

async function main() {
  const needs = process.argv.slice(2);
  if (!needs.length) { console.error('usage: node scripts/buy-dry-run.js "<need>" ["<need>" …]'); process.exit(2); }
  const filler = createFiller();
  const safeFetch = createSafeFetch({ timeoutMs: 15000 });
  const lure = createLure({ timeoutMs: 10000 });
  for (const need of needs) {
    console.log(`\n## ${need}`);
    const candidates = await candidatesFor(need, { capUsd: 0.01 });
    if (!candidates.length) { console.log('no candidates'); continue; }
    for (const c of candidates.slice(0, MAX_TRIES)) {
      const f = await filler.fill(need, c);
      if (!f.fits) { console.log(`- ${c.url} ($${c.price_usd}, ${c.record.payableDays}/${c.record.days} days, relevance ${c.relevance}): no fit: ${f.reason}`); continue; }
      const pf = await preflight(f.request.url, { safeFetch, method: f.request.method, body: f.request.body, network: 'eip155:8453', maxUsd: 0.01, lure }).catch((e) => ({ verdict: `error: ${e.message}`, reasons: [] }));
      const codes = (pf.reasons || []).filter((r) => r.level !== 'info').map((r) => r.code).join(', ');
      console.log(`- ${c.url} ($${c.price_usd}, ${c.record.payableDays}/${c.record.days} days, relevance ${c.relevance})\n    ${f.request.method} ${f.request.url}${f.request.body ? ` ${f.request.body}` : ''}\n    preflight ${pf.verdict}${codes ? ` (${codes})` : ''}; ${f.reason}`);
      if (pf.verdict === 'go') break; // the inkoper would buy this one
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
