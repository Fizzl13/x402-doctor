#!/usr/bin/env node
// What kind of service is behind each group of endpoints in the Trust Index? (run by .github/workflows/trust-scan.yml
// after the daily scan)
//
//   node scripts/categorize.js --index trust-data/index.json --previous prev-categories.json --out trust-data/categories.json [--max 1500] [--max-bait 1000]
//
// Groups the payable resources into services (lib/services.js: near-identical endpoints of one seller are one
// service) and asks TypeSafe's Jev for the category of every service description that isn't in the previous
// categories.json yet, at most --max per run (the rest are asked on the next runs). Writes categories.json:
// { updated, categories: { <description key>: <category id> } }. Needs TYPESAFE_API_KEY; without it the previous
// answers are carried over and the pages use the keyword guess for the rest. Read-only towards the services.
'use strict';

const fs = require('fs');
const { groupServices, descKey } = require('../lib/services');
const { createCategorizer } = require('../lib/jev-category');
const { createLure } = require('../lib/jev-lure');

// Runs fn over items, `limit` at a time.
async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i]); }
  }));
}

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const readJson = (path) => { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; } };

async function main() {
  const index = readJson(arg('index', 'trust-data/index.json'));
  if (!index?.resources) throw new Error('no index');
  const previous = readJson(arg('previous', '')) || {};
  const cache = { ...(previous.categories || {}) };
  const max = Number(arg('max', '1500')) || 0;

  const { services } = groupServices(index.resources);
  const todo = [];
  const seen = new Set();
  for (const s of services) {
    const text = s.rep.d || s.rep.url;
    const key = descKey(text);
    if (cache[key] || seen.has(key)) continue;
    seen.add(key);
    let host = '';
    try { host = new URL(s.rep.url).hostname; } catch {}
    todo.push({ key, host, description: text });
  }
  const ask = todo.slice(0, max);
  const answers = await createCategorizer().categorize(ask);
  Object.assign(cache, answers);

  // Bait signs per service (brand impersonation, a lure), for the bait list on /trust.
  const bait = { ...(previous.bait || {}) };
  const lure = createLure({ timeoutMs: 8000, ttlMs: 0, log: { warn() {} } });
  const baitTodo = [];
  if (lure.enabled) {
    const queued = new Set();
    for (const svc of services) {
      const text = svc.rep.d || svc.rep.url;
      const key = descKey(text);
      if (bait[key] || queued.has(key)) continue;
      queued.add(key);
      let host = '';
      try { host = new URL(svc.rep.url).hostname; } catch {}
      baitTodo.push({ key, host, description: text });
    }
    baitTodo.splice(Number(arg('max-bait', '1000')) || 0);
  }
  let baitAnswered = 0;
  await pool(baitTodo, 4, async (it) => {
    const j = await lure.judge(it.host, { description: String(it.description).slice(0, 1000), output: '' });
    if (j) { bait[it.key] = [j.impersonation, j.lure]; baitAnswered++; }
  });

  // Keep only descriptions that are still in the index, so the file doesn't grow forever.
  const live = new Set(services.map((s) => descKey(s.rep.d || s.rep.url)));
  const categories = Object.fromEntries(Object.entries(cache).filter(([k]) => live.has(k)));
  const baitLive = Object.fromEntries(Object.entries(bait).filter(([k]) => live.has(k)));
  fs.writeFileSync(arg('out', 'trust-data/categories.json'), JSON.stringify({ updated: new Date().toISOString(), categories, bait: baitLive }));

  const line = `services ${services.length}, categorized ${Object.keys(categories).length}, asked ${ask.length}, answered ${Object.keys(answers).length}, still to ask ${todo.length - ask.length}; bait-checked ${Object.keys(baitLive).length} (+${baitAnswered})`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Categories (Jev): ${line}\n`);
}

main().catch((err) => {
  // Never block publishing the scan: without categories the pages fall back to the keyword guess.
  console.error(`categorize: ${err.message}`);
});
