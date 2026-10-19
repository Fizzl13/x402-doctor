#!/usr/bin/env node
// Weekly x402 market digest (run by .github/workflows/weekly-report.yml).
//
//   node scripts/market-digest.js --out reports [--previous dir]
//
// Reads the Trust Index and its categories (the trust-data branch) and the whole CDP Bazaar, and writes
// <out>/<date>-market.md (the digest), <out>/<date>-market-posts.md (X and LinkedIn drafts for a person to
// review and post) and <out>/market/market-latest.json (the snapshot next week's digest compares with). Last
// week's snapshot is read from --previous, or from the weekly-reports branch.

const fs = require('fs');
const path = require('path');
const { createTrustIndex } = require('../lib/trust-index');
const { createBazaarIndex } = require('../lib/bazaar-index');
const { marketDigest } = require('../lib/market-digest');
const { previousFor, withBefore } = require('../lib/snapshots');

const PREVIOUS_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/weekly-reports/reports/market/market-latest.json';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

// Last week's snapshot, or null (first run, or not published yet).
async function loadPrevious(dir) {
  try {
    if (dir) return JSON.parse(fs.readFileSync(path.join(dir, 'market-latest.json'), 'utf8'));
    const res = await fetch(PREVIOUS_URL, { signal: AbortSignal.timeout(30000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const out = arg('out', 'reports');
  const trust = createTrustIndex();
  await trust.refresh();
  const map = trust.atlas();
  if (!map) throw new Error('the Trust Index could not be loaded');
  const bazaarIndex = createBazaarIndex();
  await bazaarIndex.refresh();
  const bazaar = bazaarIndex.siteCalls();
  if (!bazaar) throw new Error('the CDP Bazaar could not be read');
  const latest = await loadPrevious(arg('previous'));
  let previous = latest;
  let digest = marketDigest({ map, bazaar, previous });
  // Run again the same day: compare with what the first run compared with, not with its snapshot.
  if (previousFor(latest, digest.stats.date) !== latest) {
    previous = previousFor(latest, digest.stats.date);
    digest = marketDigest({ map, bazaar, previous });
  }
  const { stats, markdown, posts, snapshot } = digest;

  fs.mkdirSync(path.join(out, 'market'), { recursive: true });
  fs.writeFileSync(path.join(out, `${stats.date}-market.md`), markdown);
  fs.writeFileSync(path.join(out, 'market', 'market-latest.json'), `${JSON.stringify(withBefore(snapshot, previous))}\n`);
  fs.writeFileSync(path.join(out, 'market', `${stats.date}.json`), `${JSON.stringify(stats, null, 2)}\n`);
  const drafts = [
    `# Market drafts for the week of ${stats.date}`,
    '',
    'Review before posting. Routes paid many times per wallet are described, never named.',
    '',
    `## X (${posts.x_length}/280)`,
    '',
    posts.x,
    '',
    '## LinkedIn',
    '',
    posts.linkedin,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(out, `${stats.date}-market-posts.md`), drafts);
  console.log(`market digest ${stats.date}: ${stats.calls_active}/${stats.calls_30d} still paid (${stats.active_pct}%), ${stats.heavy_routes.length} routes paid 50+ times per wallet, ${stats.risers.length} risers${previous ? ` (vs ${previous.date})` : ' (no previous snapshot)'}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
