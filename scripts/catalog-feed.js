#!/usr/bin/env node
// A marketplace's daily x402 catalogue feed (lib/catalog-feed.js): the report and one event per changed listing,
// POSTed to the marketplace's webhook. Run by .github/workflows/catalog-feed.yml after the daily Trust Index scan.
//
//   node scripts/catalog-feed.js --catalogue payapi --index trust-data/index.json [--state state/payapi.json] [--out feed] [--dry]
//
// Env: CATALOG_WEBHOOK_URL and CATALOG_WEBHOOK_SECRET (repository secrets). Without both it is a dry run: the report
// is written to --out and the job summary, nothing is sent. --state holds yesterday's broken set and is rewritten.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readIndexFile } = require('../lib/index-files');
const { CATALOGUES, buildFeed, deliver } = require('../lib/catalog-feed');

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback; };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'fizzl-catalog-feed/1 (+https://x402-doctor.fizzl.eu)' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function main() {
  const key = arg('catalogue', 'payapi');
  const cat = CATALOGUES[key];
  if (!cat) throw new Error(`unknown catalogue ${key} (known: ${Object.keys(CATALOGUES).join(', ')})`);
  const index = readIndexFile(arg('index', 'trust-data/index.json'));
  const stateFile = arg('state');
  let previous = null;
  if (stateFile && fs.existsSync(stateFile)) {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (st.date === index.days[index.days.length - 1]) { console.log(`Already sent for ${st.date}: nothing to do.`); return; }
    previous = Array.isArray(st.broken) ? st.broken : null;
  }
  const { report, events, state } = buildFeed({ catalogue: key, name: cat.name, urls: await cat.urls(fetchJson), index, previous });
  const out = arg('out', 'feed');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${key}-${report.date}.json`), `${JSON.stringify({ report, events }, null, 2)}\n`);
  fs.writeFileSync(path.join(out, `${key}-${report.date}.md`), report.markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.markdown}\n${events.length} event(s).\n`);
  console.log(`${cat.name} ${report.date}: ${report.unpayable_today} unpayable, ${report.wrong_answers_today} wrong, ${report.broke_since_yesterday.length} broke, ${report.recovered_since_yesterday.length} recovered, ${report.payee_changed_today.length} payee changed; ${events.length} event(s).`);

  const url = process.env.CATALOG_WEBHOOK_URL, secret = process.env.CATALOG_WEBHOOK_SECRET;
  const dry = process.argv.includes('--dry') || !url || !secret;
  if (dry) {
    console.log(url && secret ? 'Dry run: nothing sent.' : 'No CATALOG_WEBHOOK_URL / CATALOG_WEBHOOK_SECRET: dry run, nothing sent.');
  } else {
    if (!/^https:\/\//.test(url)) throw new Error('CATALOG_WEBHOOK_URL must be https');
    let failed = 0;
    for (const payload of [report, ...events]) if (!(await deliver({ url, secret, payload }))) failed++;
    console.log(`Sent ${1 + events.length - failed} of ${1 + events.length}.`);
    if (failed) process.exitCode = 1;
  }
  // Remember today's broken set only after a real send (a dry run must not swallow a day's changes).
  if (stateFile && !dry) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`); }
}

main().catch((err) => { console.error(`catalog-feed: ${err.message}`); process.exit(1); });
