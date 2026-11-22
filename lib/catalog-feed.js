// A marketplace's x402 catalogue checked against the daily Trust Index, as a feed for that marketplace: a daily report
// (what can't be paid today, what broke or recovered since yesterday, payout addresses that changed) and one event per
// listing that changed, POSTed to the marketplace's webhook and signed with a shared secret. Started for the PayAPI
// Market pilot (22 Nov 2026): they want to pause dead listings faster.
//
// Read-only: the marketplace's own open catalogue and the published index; nothing is paid. Index history `h` has one
// character per scan day, oldest first, aligned with days: g go, c caution, n no_go, x unreachable, - not scanned.
'use strict';

const crypto = require('node:crypto');

const BAD = new Set(['n', 'x']);
const OK = new Set(['g', 'c']);
// Payable, but answering wrong: what a buyer pays for isn't what the listing promises.
const WRONG = new Set(['resource_mismatch', 'price_far_above_advertised', 'payto_sanctioned', 'payto_burn']);

const CATALOGUES = {
  payapi: {
    name: 'PayAPI Market',
    async urls(fetchJson) {
      const out = [];
      for (let off = 0; off < 20000; off += 500) {
        const page = await fetchJson(`https://payapi.market/agent/list?verified_only=false&limit=500&offset=${off}`);
        const res = (page && page.results) || [];
        for (const it of res) {
          const base = String(it.base_url || '').replace(/\/+$/, '');
          if (base) out.push(base);
          for (const v of it.verified_routes || []) {
            const r = String(v.route || '');
            out.push(r.startsWith('http') ? r : base + (r.startsWith('/') ? '' : '/') + r);
          }
        }
        if (res.length < 500) break;
      }
      return out;
    },
  },
};

const norm = (u) => String(u || '').trim().replace(/\/+$/, '');
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const recordLink = (u) => `https://x402-doctor.fizzl.eu/?url=${u}`;
const payableDays = (h) => { const s = [...h].filter((c) => c !== '-'); return `${s.filter((c) => OK.has(c)).length}/${s.length}`; };
const problemCodes = (r) => (r.last && Array.isArray(r.last.codes) ? r.last.codes : []);
const unpayableToday = (r) => BAD.has(r.h.slice(-1));
const wrongToday = (r) => OK.has(r.h.slice(-1)) && problemCodes(r).some((c) => WRONG.has(c));
const brokenToday = (r) => unpayableToday(r) || wrongToday(r);

// The report and the events for one catalogue. index: { days, updated, resources: { url: record } }.
function buildFeed({ catalogue, name, urls, index, previous = null }) {
  const today = index.days[index.days.length - 1];
  const listed = [...new Set(urls.map(norm).filter((u) => u.startsWith('https://')))].sort();
  const found = listed.map((u) => index.resources[u]).filter(Boolean);
  const scanned = found.filter((r) => r.h.slice(-1) !== '-');
  const unpayable = scanned.filter(unpayableToday);
  const wrong = scanned.filter(wrongToday);
  const item = (r) => ({ url: r.url, host: hostOf(r.url), verdict: r.last.verdict, reasons: problemCodes(r), payable_days_30d: payableDays(r.h), record: recordLink(r.url) });
  // Broke / recovered since yesterday. With yesterday's broken set (state from the previous run) both kinds count:
  // can't be paid, and payable but answering wrong. Without it, the index history alone: unpayable today after a
  // payable scan day, and the other way round.
  const before = (r) => [...r.h.slice(0, -1)].reverse().find((c) => c !== '-');
  const brokenNow = scanned.filter(brokenToday);
  let brokeNow;
  let recovered;
  if (previous) {
    const prev = new Set(previous);
    brokeNow = brokenNow.filter((r) => !prev.has(r.url));
    recovered = scanned.filter((r) => prev.has(r.url) && !brokenToday(r));
  } else {
    brokeNow = scanned.filter((r) => unpayableToday(r) && OK.has(before(r) || ''));
    recovered = scanned.filter((r) => OK.has(r.h.slice(-1)) && !wrongToday(r) && BAD.has(before(r) || ''));
  }
  const payee = scanned.filter((r) => r.pt && r.pt.s === today && r.h.length > 1 && [...r.h.slice(0, -1)].some((c) => c !== '-'));
  const events = [
    ...brokeNow.map((r) => ({ event: 'listing.broke', catalogue, since: today, ...item(r) })),
    ...recovered.map((r) => ({ event: 'listing.recovered', catalogue, since: today, ...item(r) })),
    ...payee.map((r) => ({ event: 'listing.payee_changed', catalogue, since: today, ...item(r), networks: Object.keys((r.pt && r.pt.a) || {}) })),
  ];
  const report = {
    event: 'report.daily',
    catalogue,
    date: today,
    scan: index.updated,
    listed: { urls: listed.length, hosts: new Set(listed.map(hostOf)).size, in_index: found.length, scanned_today: scanned.length },
    unpayable_today: unpayable.length,
    wrong_answers_today: wrong.length,
    wrong_answers: wrong.map(item),
    broke_since_yesterday: brokeNow.map(item),
    recovered_since_yesterday: recovered.map(item),
    payee_changed_today: payee.map(item),
  };
  report.markdown = markdown(name, report, unpayable);
  // Today's broken set, for tomorrow's run.
  const state = { date: today, broken: brokenNow.map((r) => r.url) };
  return { report, events, state };
}

function markdown(name, r, unpayable) {
  const L = [`# ${name}: x402 catalogue health, ${r.date}`, '', `From the x402 Trust Index scan of ${String(r.scan).slice(0, 16).replace('T', ' ')} UTC. Public data, nothing paid.`, ''];
  L.push(`- Listed: ${r.listed.urls} URLs on ${r.listed.hosts} hosts; in the index: ${r.listed.in_index}; scanned today: ${r.listed.scanned_today}.`);
  L.push(`- Can't be paid today: **${r.unpayable_today}**. Payable but answering wrong: ${r.wrong_answers_today}.`);
  L.push(`- Broke since yesterday: **${r.broke_since_yesterday.length}**. Recovered: ${r.recovered_since_yesterday.length}. Payout address changed today: ${r.payee_changed_today.length}.`);
  const list = (title, items) => { if (!items.length) return; L.push('', `## ${title}`); for (const i of items.slice(0, 50)) L.push(`- ${i.url}: ${i.reasons.join(', ') || i.verdict} (${i.record})`); if (items.length > 50) L.push(`- … and ${items.length - 50} more (all in the JSON)`); };
  list('Broke since yesterday', r.broke_since_yesterday);
  list('Recovered since yesterday', r.recovered_since_yesterday);
  list('Payout address changed today', r.payee_changed_today);
  const byHost = new Map();
  for (const x of unpayable) byHost.set(hostOf(x.url), (byHost.get(hostOf(x.url)) || 0) + 1);
  const top = [...byHost].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length) { L.push('', "## Hosts with the most listings that can't be paid today", '| Host | Listings |', '|---|---|'); for (const [h, n] of top) L.push(`| ${h} | ${n} |`); }
  return `${L.join('\n')}\n`;
}

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

// POSTs one payload; retries after the given delays (ms) on a non-2xx or a network error. Returns true when delivered.
async function deliver({ url, secret, payload, fetchImpl = fetch, delays = [60000, 300000, 1800000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console }) {
  const body = JSON.stringify(payload);
  const id = crypto.createHash('sha256').update(`${payload.event}|${payload.catalogue}|${payload.date || payload.since}|${payload.url || ''}`).digest('hex').slice(0, 24);
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fizzl-event': payload.event, 'x-fizzl-delivery': id, 'x-fizzl-signature': sign(secret, body), 'user-agent': 'fizzl-catalog-feed/1 (+https://x402-doctor.fizzl.eu)' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (res.status >= 200 && res.status < 300) return true;
      log.warn(`[catalog-feed] ${payload.event}: webhook answered ${res.status}`);
    } catch (err) {
      log.warn(`[catalog-feed] ${payload.event}: ${err.message}`);
    }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  return false;
}

module.exports = { CATALOGUES, buildFeed, deliver, sign };
