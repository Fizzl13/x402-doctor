#!/usr/bin/env node
// Weekly x402 health report (run by .github/workflows/weekly-report.yml).
//
//   node scripts/weekly-report.js --out reports [--index trust-data/index.json]
//
// Reads the Trust Index (a local file, or the published trust-data branch)
// and writes <out>/<date>.md (the report), <out>/<date>.json (the numbers)
// and <out>/<date>-posts.md (X, Discord and Reddit drafts for a person to review and send).

const fs = require('fs');
const path = require('path');
const { weeklyReport } = require('../lib/weekly-report');

const INDEX_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/index.json';

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

async function main() {
  const out = arg('out', 'reports');
  const index = await loadIndex(arg('index'));
  const { stats, markdown, posts } = weeklyReport(index);
  const date = stats.window.to;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${date}.md`), markdown);
  fs.writeFileSync(path.join(out, `${date}.json`), `${JSON.stringify(stats, null, 2)}\n`);
  const drafts = [
    `# Drafts for the week ending ${date}`,
    '',
    'Review before posting. Numbers only; no seller is named.',
    '',
    `## X (${posts.x_length}/280)`,
    '',
    posts.x,
    '',
    '## Discord',
    '',
    posts.discord,
    '',
    '## Reddit (r/x402)',
    '',
    posts.reddit,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(out, `${date}-posts.md`), drafts);
  console.log(`week ending ${date}: ${stats.resources} resources, ${stats.clean_pct}% clean, ${stats.no_go_pct}% not payable`);
  console.log(`wrote ${out}/${date}.md, ${date}.json, ${date}-posts.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
