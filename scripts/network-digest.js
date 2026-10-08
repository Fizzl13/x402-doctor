#!/usr/bin/env node
// Weekly digest per payment network (run by .github/workflows/weekly-report.yml).
//
//   node scripts/network-digest.js --out reports [--index trust-data/index.json] [--previous dir]
//
// For Algorand and the XRP Ledger: writes <out>/<date>-<network>.md (the digest),
// <out>/<date>-<network>-posts.md (X and community drafts for a person to review
// and send) and <out>/networks/<network>-latest.json (the snapshot next week's
// digest compares with). Last week's snapshot is read from --previous, or from
// the weekly-reports branch.

const fs = require('fs');
const path = require('path');
const { networkDigest, NETWORKS } = require('../lib/network-digest');

const INDEX_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/index.json';
const PREVIOUS_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/weekly-reports/reports/networks';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function loadIndex(source) {
  if (source && !/^https?:/.test(source)) return JSON.parse(fs.readFileSync(source, 'utf8'));
  const res = await fetch(source || INDEX_URL, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`trust index HTTP ${res.status}`);
  return res.json();
}

// Last week's snapshot, or null (first run, or not published yet).
async function loadPrevious(family, dir) {
  const file = `${family}-latest.json`;
  try {
    if (dir) return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const res = await fetch(`${PREVIOUS_URL}/${file}`, { signal: AbortSignal.timeout(30000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const out = arg('out', 'reports');
  const index = await loadIndex(arg('index'));
  fs.mkdirSync(path.join(out, 'networks'), { recursive: true });
  for (const family of Object.keys(NETWORKS)) {
    const previous = await loadPrevious(family, arg('previous'));
    const { stats, snapshot, markdown, posts } = networkDigest(index, family, previous);
    const date = stats.date;
    fs.writeFileSync(path.join(out, `${date}-${family}.md`), markdown);
    fs.writeFileSync(path.join(out, 'networks', `${family}-latest.json`), `${JSON.stringify(snapshot)}\n`);
    fs.writeFileSync(path.join(out, `${date}-${family}-posts.md`), [
      `# Drafts: x402 on ${NETWORKS[family].name}, week ending ${date}`,
      '',
      'Review before posting. Only payable sellers are named; problems are counted, not named.',
      '',
      `## X (${posts.x_length}/280)`,
      '',
      posts.x,
      '',
      '## Community (Discord, forum)',
      '',
      posts.community,
      '',
    ].join('\n'));
    console.log(`${family} ${date}: ${stats.payable} payable endpoints from ${stats.payable_sellers} sellers, ${stats.added} new${stats.stopped != null ? `, ${stats.stopped} stopped` : ''}${previous ? ` (vs ${previous.date})` : ' (no previous snapshot)'}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
