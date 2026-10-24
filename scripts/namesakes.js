#!/usr/bin/env node
// Namesakes in the Trust Index (run by .github/workflows/trust-scan.yml after the categories, before the views): one
// service name listed by several sellers with different payout addresses (lib/namesakes.js).
//
//   node scripts/namesakes.js --dir trust-data [--previous prev-namesakes.json]
//
// Reads the CDP Bazaar listings, finds the cases, asks TypeSafe's Jev whether each name is a brand (names answered
// before are carried over from --previous, so a run only asks the new ones), and marks the namesakes' resources in
// <dir>/index.json and index.ndjson (field ns), which the preflight's track-record lookup returns. Writes
// <dir>/namesakes.json: { updated, brand: { name: probability }, cases: [...] } with the brand cases (own_site_name
// when the name is the original's own site name, which counts whatever Jev said). Without
// TYPESAFE_API_KEY only the carried-over answers count. Read-only towards the sellers.
'use strict';

const fs = require('fs');
const path = require('path');
const { loadCatalogItems, indexLines } = require('../lib/trust-scan');
const { casesOf, createBrandCheck, namesakeEntries, lesserOf, ownSiteName, isBrand, BRAND_SURE } = require('../lib/namesakes');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

async function main() {
  const dir = arg('dir', 'trust-data');
  const indexPath = path.join(dir, 'index.json');
  const index = readJson(indexPath);
  if (!index?.resources) throw new Error('no index');
  const previous = readJson(arg('previous', '')) || {};

  const items = await loadCatalogItems();
  const cases = casesOf(items);
  const brand = { ...(previous.brand || {}) };
  const ask = cases.filter((c) => typeof brand[c.name] !== 'number');
  Object.assign(brand, await createBrandCheck().brands(ask));
  // Only names still in a case are kept.
  const live = new Set(cases.map((c) => c.name));
  for (const name of Object.keys(brand)) if (!live.has(name)) delete brand[name];

  const entries = namesakeEntries(cases, brand);
  let marked = 0;
  for (const [key, entry] of Object.entries(index.resources)) {
    if (entries[key]) { entry.ns = entries[key]; marked++; } else delete entry.ns;
  }
  fs.writeFileSync(indexPath, JSON.stringify(index));
  fs.writeFileSync(path.join(dir, 'index.ndjson'), `${[...indexLines(index)].join('\n')}\n`);

  const flagged = cases.filter((c) => isBrand(c, brand) && lesserOf(c).length).map((c) => ({
    name: c.label,
    brand: brand[c.name],
    ...(ownSiteName(c) ? { own_site_name: true } : {}),
    original: { sites: c.original.sites, url: c.original.url, payers: c.original.payers, calls: c.original.calls },
    namesakes: lesserOf(c).map((n) => ({ sites: n.sites, url: n.url, payers: n.payers, calls: n.calls, endpoints: n.keys.length })),
  }));
  fs.writeFileSync(path.join(dir, 'namesakes.json'), JSON.stringify({ updated: new Date().toISOString(), brand, cases: flagged }, null, 2));

  console.log(`listings ${items.length}, names on more than one owner ${cases.length}, asked Jev ${ask.length}, brands ${flagged.length}, resources marked ${marked}`);
  const lines = ['## Namesakes', '', `${cases.length} names are listed by more than one owner; ${flagged.length} of them are brands (TypeSafe Jev ≥ ${BRAND_SURE}, or the original's own site name) with a better-known original.`, '', '| Name | Original | Namesakes |', '|---|---|---|',
    ...flagged.map((c) => `| ${c.name} | ${c.original.sites.join(', ')} (${c.original.payers} payers) | ${c.namesakes.map((n) => `${n.sites.join(', ')} (${n.payers})`).join('; ')} |`)];
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
