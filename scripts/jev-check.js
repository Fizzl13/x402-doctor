// What TypeSafe's Jev says about one paid API, asked the way the paid preflight asks it, with the raw scores the
// preflight keeps to itself: the bait check (brand impersonation, lure, output mismatch; lib/jev-lure.js) and the
// price check (lib/jev-price.js), next to the preflight's verdict and reasons. Read-only: it fetches the 402 and
// the Trust Index, nothing is paid and nobody is contacted. Needs TYPESAFE_API_KEY (the workflow jev-check.yml
// has it as a repository secret). Prints Markdown, and adds it to the run summary on GitHub.
//   node scripts/jev-check.js <url> [GET|POST]
'use strict';

const fs = require('node:fs');
const { createSafeFetch } = require('../lib/safe-fetch');
const { preflight } = require('../lib/preflight');
const { createTrustIndex } = require('../lib/trust-index');
const { createLure } = require('../lib/jev-lure');
const { createPriceCheck } = require('../lib/jev-price');

// The bars the preflight uses (lureReasons, priceReason), to show how far each score is from them.
const BARS = { impersonation: 0.85, lure: 0.85, mismatch: 0.95 };

function report(url, result, seen) {
  const lines = [`## Jev check: ${url}`, '', `Preflight verdict: **${result.verdict}**`, ''];
  for (const r of result.reasons || []) lines.push(`- ${r.level} \`${r.code}\`: ${r.message}`);
  lines.push('', '### Bait check (caution from the bar, info from 0.5)', '');
  if (!seen.bait) lines.push('No answer: no description to judge, or Jev failed or timed out.');
  else for (const [name, p] of Object.entries(seen.bait)) lines.push(`- ${name}: ${p === null ? 'not asked' : `${p} (bar ${BARS[name]})`}`);
  lines.push('', '### Price check (info from 5x and $0.05 above, caution from 20x and $0.25 above)', '');
  const c = seen.price;
  if (!c) lines.push('No answer: no USDC price, fewer than 5 comparable services, or Jev failed or timed out.');
  else {
    lines.push(`- $${c.price_usd}: ${c.ratio}x the median of $${c.comparable_median_usd} across ${c.comparables} comparable services (range $${c.range_usd[0]} to $${c.range_usd[1]})`);
    for (const x of c.cheaper) lines.push(`- cheaper: ${x.url} ($${x.price_usd}): ${x.description}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const [url, method] = process.argv.slice(2);
  if (!url) { console.error('usage: node scripts/jev-check.js <url> [GET|POST]'); process.exit(2); }
  if (!process.env.TYPESAFE_API_KEY) { console.error('TYPESAFE_API_KEY is not set'); process.exit(1); }
  const trustIndex = createTrustIndex();
  await trustIndex.refresh();
  // Longer timeouts than the live preflight's, so a slow answer is shown instead of skipped.
  const lure = createLure({ timeoutMs: 20000 });
  const price = createPriceCheck({ trustIndex, timeoutMs: 20000 });
  const seen = {};
  const result = await preflight(url, {
    safeFetch: createSafeFetch(),
    method: method ? method.toUpperCase() : undefined,
    trustIndex,
    lure: { enabled: lure.enabled, judge: async (...a) => (seen.bait = await lure.judge(...a)) },
    price: { enabled: price.enabled, compare: async (...a) => (seen.price = await price.compare(...a)) },
  });
  const md = report(url, result, seen);
  process.stdout.write(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { report };
