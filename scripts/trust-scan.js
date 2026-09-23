#!/usr/bin/env node
// Daily x402 Trust Index scan (run by .github/workflows/trust-scan.yml).
//
//   node scripts/trust-scan.js --out trust-data [--limit 200]
//
// Reads <out>/index.json (the previous 30-day index, if any), scans every
// resource in the CDP Bazaar with the pre-payment check, and writes
// <out>/index.json and <out>/summary.json.

const fs = require('fs');
const path = require('path');
const { createSafeFetch } = require('../lib/safe-fetch');
const { loadCatalog, scan, mergeIndex, summarize } = require('../lib/trust-scan');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const out = arg('out', 'trust-data');
  const limit = Number(arg('limit', 0));
  fs.mkdirSync(out, { recursive: true });
  const indexPath = path.join(out, 'index.json');
  const previous = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : null;

  let resources = await loadCatalog();
  console.log(`catalog: ${resources.length} resources`);
  if (limit > 0) resources = resources.slice(0, limit);

  const started = Date.now();
  const results = await scan(resources, {
    safeFetch: createSafeFetch({ allowPrivate: false, timeoutMs: 10000 }),
    rpcUrl: process.env.SOLANA_RPC_URL || undefined,
    onProgress: (done, total) => console.log(`scanned ${done}/${total} (${Math.round((Date.now() - started) / 1000)} s)`),
  });

  const date = new Date().toISOString().slice(0, 10);
  const descriptions = new Map(resources.map((r) => [r.key, r.description]));
  const index = mergeIndex(previous, results, { date, descriptions });
  const summary = { ...summarize(index), scan_seconds: Math.round((Date.now() - started) / 1000) };

  fs.writeFileSync(indexPath, JSON.stringify(index));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
