#!/usr/bin/env node
// Which sellers in the Trust Index are worth an outreach mail? (run by .github/workflows/triage.yml)
//
//   node scripts/triage-candidates.js --index trust-data/index.json [--limit 40]
//
// Takes the resources whose last verdict is caution or no_go for a reason a gateway would fix (not merely
// unreachable), one per host, runs the free pre-payment check on each again (read-only, nothing is paid),
// and asks Jev (lib/jev-triage.js) whether it is a test service and whether the findings would really hurt
// a paying agent. Prints a Markdown table, most worth mailing first. Needs TYPESAFE_API_KEY; without it
// the table has no Jev columns. No seller is contacted.
'use strict';

const fs = require('fs');
const { createSafeFetch } = require('../lib/safe-fetch');
const { preflight } = require('../lib/preflight');
const { createTriage } = require('../lib/jev-triage');

const WANT = new Set(['resource_mismatch', 'invalid_challenge', 'no_payable_option', 'price_above_advertised', 'unknown_asset', 'testnet_only', 'network_not_offered']);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[a-z]{2,24}$/i;

async function contactOf(safeFetch, origin) {
  try {
    const res = await safeFetch(`${origin}/openapi.json`);
    const email = String(JSON.parse(res.text)?.info?.contact?.email ?? '').trim();
    return EMAIL_RE.test(email) ? email : null;
  } catch { return null; }
}

async function main() {
  const index = JSON.parse(fs.readFileSync(arg('index', 'trust-data/index.json'), 'utf8'));
  const limit = Number(arg('limit', 40));
  const perHost = new Map();
  for (const r of Object.values(index.resources || {})) {
    const codes = r.last?.codes || [];
    if (!['caution', 'no_go'].includes(r.last?.verdict) || !codes.some((c) => WANT.has(c))) continue;
    let host;
    try { host = new URL(r.url).hostname; } catch { continue; }
    if (/(^|\.)fizzl\.eu$|\.onrender\.com$/.test(host) || /\/:[a-z_]+|\{[a-z_]+\}/i.test(r.url)) continue; // own, and template paths
    if (!perHost.has(host)) perHost.set(host, r);
  }
  const picks = [...perHost.values()].slice(0, limit);
  console.error(`${perHost.size} hosts with a fixable caution/no_go; checking ${picks.length}`);

  const safeFetch = createSafeFetch({ allowPrivate: false, timeoutMs: 10000 });
  const triage = createTriage({ log: { warn: (m) => console.error(m) } });
  const rows = [];
  for (const r of picks) {
    const p = await preflight(r.url, { safeFetch, preferMethod: r.m || undefined }).catch((e) => ({ verdict: 'error', reasons: [{ code: 'error', message: e.message }] }));
    const findings = (p.reasons || []).filter((x) => WANT.has(x.code) || x.code === 'error').map((x) => ({ id: x.code, message: x.message }));
    if (!findings.length) { rows.push({ url: r.url, verdict: p.verdict, findings: 'fixed since the scan', jev: null, contact: null }); continue; }
    const [jev, contact] = await Promise.all([triage.judge({ url: r.url, findings }), contactOf(safeFetch, new URL(r.url).origin)]);
    rows.push({ url: r.url, verdict: p.verdict, findings: findings.map((f) => `${f.id}: ${f.message}`).join(' · '), jev, contact });
  }
  const rank = (x) => (x.jev ? (x.jev.worth ? 2 + x.jev.real : x.jev.real) : 1);
  rows.sort((a, b) => rank(b) - rank(a));
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 300);
  const lines = [
    '| Worth a mail | Endpoint | Verdict now | Findings | Jev | Contact |',
    '|---|---|---|---|---|---|',
    ...rows.map((x) => `| ${x.jev ? (x.jev.worth ? 'yes' : 'no') : '?'} | ${cell(x.url)} | ${x.verdict} | ${cell(x.findings)} | ${x.jev ? cell(`${x.jev.why} (test ${Math.round(x.jev.test * 100)}%, real ${Math.round(x.jev.real * 100)}%)`) : triage.enabled ? 'no answer' : 'off'} | ${cell(x.contact || '')} |`),
  ];
  const md = `## Outreach candidates (${new Date().toISOString().slice(0, 10)})\n\n${lines.join('\n')}\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((err) => { console.error(err); process.exit(1); });
