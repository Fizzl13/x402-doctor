#!/usr/bin/env node
// Which sellers in the Trust Index are worth an outreach mail? (run by .github/workflows/triage.yml)
//
//   node scripts/triage-candidates.js --index trust-data/index.json [--limit 0] [--draft] [--max-drafts 10]
//   (limit 0 = every candidate)
//
// Takes the resources whose last verdict is caution or no_go for a reason a gateway would fix (not merely
// unreachable), one per host, runs the free pre-payment check on each again (read-only, nothing is paid),
// and asks Jev (lib/jev-triage.js) whether it is a test service and whether the findings would really hurt
// a paying agent. Prints a Markdown table, most worth mailing first. Needs TYPESAFE_API_KEY; without it
// the table has no Jev columns. No seller is contacted.
//
// --draft: for each seller Jev (or Claude) calls worth a mail and that publishes a contact address, hand a
// draft to the wallet server (OUTREACH_URL, OUTREACH_KEY), the same way the free check does. The wallet
// server only makes drafts (one mail per address, ever) and tells the owner on Telegram; nothing is sent
// until the owner presses Send. At most --max-drafts per run (default 10).
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
  const limit = Number(arg('limit', 0));
  const perHost = new Map();
  for (const r of Object.values(index.resources || {})) {
    const codes = r.last?.codes || [];
    if (!['caution', 'no_go'].includes(r.last?.verdict) || !codes.some((c) => WANT.has(c))) continue;
    let host;
    try { host = new URL(r.url).hostname; } catch { continue; }
    if (/(^|\.)fizzl\.eu$|\.onrender\.com$/.test(host) || /\/:[a-z_]+|\{[a-z_]+\}/i.test(r.url)) continue; // own, and template paths
    if (!perHost.has(host)) perHost.set(host, r);
  }
  const picks = limit > 0 ? [...perHost.values()].slice(0, limit) : [...perHost.values()];
  console.error(`${perHost.size} hosts with a fixable caution/no_go; checking ${picks.length}`);

  const safeFetch = createSafeFetch({ allowPrivate: false, timeoutMs: 10000 });
  const triage = createTriage({ log: { warn: (m) => console.error(m) } });
  const rows = [];
  // A few at a time: each host is asked once, the preflight is read-only.
  const one = async (r) => {
    const p = await preflight(r.url, { safeFetch, preferMethod: r.m || undefined }).catch((e) => ({ verdict: 'error', reasons: [{ code: 'error', message: e.message }] }));
    const findings = (p.reasons || []).filter((x) => WANT.has(x.code) || x.code === 'error').map((x) => ({ id: x.code, message: x.message }));
    if (!findings.length) { rows.push({ url: r.url, verdict: p.verdict, findings: 'no longer flagged (fixed, or an old Doctor false alarm)', jev: null, contact: null, cleared: true }); return; }
    const [jev, contact] = await Promise.all([triage.judge({ url: r.url, findings }), contactOf(safeFetch, new URL(r.url).origin)]);
    rows.push({ url: r.url, verdict: p.verdict, findings: findings.map((f) => `${f.id}: ${f.message}`).join(' · '), findingList: findings.map((f) => ({ ...f, hint: null })), jev, contact });
  };
  const queue = [...picks];
  await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
  const rank = (x) => (x.cleared ? -2 : !x.jev ? 0 : x.jev.worth === true ? 3 + (x.jev.real ?? 0) : x.jev.worth === null ? 2 + (x.jev.real ?? 0) : -1);
  rows.sort((a, b) => rank(b) - rank(a));
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 300);
  const lines = [
    '| Worth a mail | Endpoint | Verdict now | Findings | Jev | Contact | Draft |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((x) => {
      const worth = x.cleared ? '–' : !x.jev ? '?' : x.jev.worth === true ? 'yes' : x.jev.worth === false ? 'no' : 'unsure';
      const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '–');
      const jev = x.cleared ? '–' : x.jev ? `${x.jev.why} [${x.jev.decidedBy}; test ${pct(x.jev.test)}, real ${pct(x.jev.real)}]` : triage.enabled ? 'no answer' : 'off';
      return `| ${worth} | ${cell(x.url)} | ${x.verdict} | ${cell(x.findings)} | ${cell(jev)} | ${cell(x.contact || '')} | ${cell(x.draft || '')} |`;
    }),
  ];
  // Drafts for the sellers worth a mail (never sent from here).
  if (process.argv.includes('--draft')) {
    const url = process.env.OUTREACH_URL, key = process.env.OUTREACH_KEY;
    const max = Number(arg('max-drafts', 10));
    if (!url || !key) console.error('[draft] off: OUTREACH_URL and OUTREACH_KEY are not set');
    else {
      let made = 0;
      for (const x of rows.filter((r) => r.jev?.worth === true && r.contact)) {
        if (made >= max) { x.draft = 'over this run\'s limit'; continue; }
        try {
          const res = await fetch(`${url.replace(/\/$/, '')}/hooks/outreach-draft`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ via: "scan", url: x.url, to: x.contact, findings: x.findingList, reportUrl: `https://x402-doctor.fizzl.eu/?url=${encodeURIComponent(x.url)}` }),
            signal: AbortSignal.timeout(10_000),
          });
          const body = await res.json().catch(() => null);
          x.draft = !res.ok ? `refused (HTTP ${res.status})` : body?.draft ? 'draft made' : `no draft (${body?.skipped || body?.message || 'unknown'})`;
          if (body?.draft) made++;
        } catch (err) { x.draft = `failed (${err.name})`; }
      }
      console.error(`[draft] ${made} draft(s) made`);
    }
  }
  const count = (f) => rows.filter(f).length;
  const md = `## Outreach candidates (${new Date().toISOString().slice(0, 10)})\n\n${count((x) => x.jev?.worth === true)} worth a mail, ${count((x) => x.jev?.worth === null)} unsure, ${count((x) => x.jev?.worth === false)} not (test service or harmless), ${count((x) => x.cleared)} no longer flagged, of ${rows.length} hosts.\n\n${lines.join('\n')}\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((err) => { console.error(err); process.exit(1); });
