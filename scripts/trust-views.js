#!/usr/bin/env node
// After the daily scan and its categories step: the Trust Index as small precomputed files (lib/trust-views.js),
// which the Doctor reads instead of loading the whole index (lib/trust-reader.js).
//
//   node scripts/trust-views.js --dir trust-data

const fs = require('fs');
const path = require('path');
const { buildViews } = require('../lib/trust-views');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

async function main() {
  const dir = arg('dir', 'trust-data');
  const index = read(path.join(dir, 'index.json'));
  if (!index?.resources) throw new Error(`no index in ${dir}/index.json`);
  const files = await buildViews({ index, categories: read(path.join(dir, 'categories.json')), submitted: read(path.join(dir, 'submitted.json')) });
  let bytes = 0;
  for (const [rel, value] of files) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(value);
    fs.writeFileSync(file, text);
    bytes += text.length;
  }
  const meta = files.get('views/meta.json');
  console.log(`views: ${files.size} files, ${Math.round(bytes / 1e6)} MB; ${meta.networks.length} network views; summary of ${meta.summary.resources} resources`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
