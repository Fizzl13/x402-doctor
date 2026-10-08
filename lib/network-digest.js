// Weekly digest per payment network (Algorand, the XRP Ledger), from the Trust
// Index: how many x402 endpoints accept the network, how many an agent could
// pay today, what changed since last week, and drafts (X and a community post)
// that a person reviews and posts.
//
// Unlike the ecosystem report (lib/weekly-report.js), the digest names sellers,
// but only for good news: the biggest and the new ones that are payable. Problems
// are counted, never named.
//
// What changed since last week comes from last week's snapshot (networkDigest's
// `snapshot`, kept on the weekly-reports branch). Without one, "new" falls back
// to endpoints first seen by the daily scan this week, and "stopped" is unknown.

const { siteOf } = require('./trust-index');
const { WINDOW_DAYS } = require('./weekly-report');

const NETWORKS = {
  algorand: { name: 'Algorand', page: 'https://x402-doctor.fizzl.eu/algorand', tag: '#Algorand' },
  xrpl: { name: 'the XRP Ledger', page: 'https://x402-doctor.fizzl.eu/xrpl', tag: '#XRPL' },
};
const BASE = 'eip155:8453';

const matches = (n, family) => n === family || String(n).startsWith(`${family}:`);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const fmt = (n) => n.toLocaleString('en-US');
const usd = (n) => (n == null ? 'n/a' : `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`);
const list = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// The history string h is aligned to the end of index.days (older letters may be missing).
function letterAt(h, days, i) {
  const offset = days.length - h.length;
  return i - offset >= 0 ? h[i - offset] : '-';
}

// Every x402 endpoint seen in the latest scan that offers the network (payable on it or not).
function networkRows(index, family) {
  const days = index.days || [];
  const last = days.length - 1;
  if (last < 0) throw new Error('empty index');
  const first = Math.max(0, days.length - WINDOW_DAYS);
  const rows = [];
  for (const [key, e] of Object.entries(index.resources || {})) {
    if (e.p === 'mpp' || !e.last || !e.h) continue;
    if (letterAt(e.h, days, last) === '-') continue; // not seen in the latest scan
    const networks = (e.last.networks || []).filter(Boolean);
    const on = networks.filter((n) => matches(n, family));
    const broken = Object.entries(e.last.unpayable || {}).filter(([n]) => matches(n, family));
    if (!on.length && !broken.length) continue;
    let host = null;
    try { host = new URL(e.url).hostname; } catch { /* keep null */ }
    const payable = on.length > 0 && ['go', 'caution'].includes(e.last.verdict);
    let seenBefore = false;
    for (let i = first; i < last; i++) if (letterAt(e.h, days, i) !== '-') seenBefore = true;
    rows.push({
      key,
      site: host ? siteOf(host) : null,
      payable,
      price: typeof e.last.price_usd === 'number' ? e.last.price_usd : null,
      only: payable && networks.every((n) => matches(n, family)),
      base: networks.includes(BASE),
      problem: payable ? null : (broken[0]?.[1] ?? e.last.verdict),
      first_seen_this_week: last > first && !seenBefore,
    });
  }
  return { date: days[last], rows };
}

// "accepts[2]: extra.name … is missing; …" -> "extra.name … is missing", so the same problem counts once.
const problemKey = (p) => String(p || 'not payable').replace(/^accepts\[\d+\]:\s*/, '').split(/;\s/)[0].slice(0, 140);

function digestStats(index, family, previous = null) {
  if (!NETWORKS[family]) throw new Error(`unknown network family: ${family}`);
  const { date, rows } = networkRows(index, family);
  const payable = rows.filter((r) => r.payable);
  const payableKeys = new Set(payable.map((r) => r.key));
  const bySite = {};
  for (const r of payable) if (r.site) bySite[r.site] = (bySite[r.site] || 0) + 1;
  const prices = payable.map((r) => r.price).filter((p) => p != null).sort((a, b) => a - b);
  const problems = {};
  for (const r of rows) if (!r.payable) problems[problemKey(r.problem)] = (problems[problemKey(r.problem)] || 0) + 1;

  const prev = previous && previous.network === family ? previous : null;
  const prevAll = new Set(prev?.all || []);
  const prevSites = new Set(prev?.sites || []);
  const added = prev ? rows.filter((r) => !prevAll.has(r.key)).length : rows.filter((r) => r.first_seen_this_week).length;
  const stopped = prev ? (prev.payable || []).filter((k) => !payableKeys.has(k)).length : null;
  const newSellers = prev
    ? Object.entries(bySite).filter(([s]) => !prevSites.has(s)).sort((a, b) => b[1] - a[1]).map(([host, endpoints]) => ({ host, endpoints }))
    : null;

  const stats = {
    network: family,
    name: NETWORKS[family].name,
    date,
    since: prev?.date ?? null,
    endpoints: rows.length,
    payable: payable.length,
    payable_pct: pct(payable.length, rows.length),
    sellers: new Set(rows.map((r) => r.site).filter(Boolean)).size,
    payable_sellers: Object.keys(bySite).length,
    only_here: payable.filter((r) => r.only).length,
    also_base_pct: pct(payable.filter((r) => r.base).length, payable.length),
    median_price_usd: prices.length ? prices[Math.floor(prices.length / 2)] : null,
    added,
    stopped,
    new_sellers: newSellers,
    top_sellers: Object.entries(bySite).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([host, endpoints]) => ({ host, endpoints })),
    problems: Object.entries(problems).sort((a, b) => b[1] - a[1]).map(([problem, count]) => ({ problem, count })),
  };
  // Next week's comparison: which endpoints offered the network, which were payable, and by which sellers.
  const snapshot = { network: family, date, all: rows.map((r) => r.key).sort(), payable: [...payableKeys].sort(), sites: Object.keys(bySite).sort() };
  return { stats, snapshot };
}

// Endpoints that stop answering 402 drop out of the network view, so "payable" is near 100% by construction:
// say how many can be paid, and only mention the others when there are any.
const payableLine = (s) => `${fmt(s.payable)} endpoints from ${fmt(s.payable_sellers)} sellers could be paid on ${NETWORKS[s.network].name}${s.endpoints > s.payable ? ` (${fmt(s.endpoints - s.payable)} more list it but can't be paid there)` : ''}`;
const reachLine = (s) => (s.only_here
  ? `${fmt(s.only_here)} accept only ${NETWORKS[s.network].name}; ${s.also_base_pct}% also accept USDC on Base`
  : `all of them accept other networks too; ${s.also_base_pct}% accept USDC on Base`);

function changeLine(s) {
  const parts = [`**${fmt(s.added)}** new endpoint${s.added === 1 ? '' : 's'}`];
  if (s.stopped != null) parts.push(`**${fmt(s.stopped)}** stopped being payable`);
  if (s.new_sellers?.length) parts.push(`new sellers: ${list(s.new_sellers.slice(0, 5).map((x) => x.host))}`);
  return `${s.since ? `Since ${s.since}` : 'This week'}: ${parts.join(', ')}.`;
}

function renderMarkdown(s) {
  const n = NETWORKS[s.network];
  return [
    `# x402 on ${n.name}, week ending ${s.date}`,
    '',
    `Every x402 endpoint in the Trust Index (the CDP Bazaar and other public discovery lists) that accepts payment on ${n.name}, checked daily the way a paying agent would (the 402 challenge only, never paid).`,
    '',
    `- On ${s.date}, ${payableLine(s)}.`,
    `- ${changeLine(s)}`,
    `- ${reachLine(s)[0].toUpperCase()}${reachLine(s).slice(1)}.`,
    `- Median price of a payable call: **${usd(s.median_price_usd)}**.`,
    ...(s.top_sellers.length ? [`- Most endpoints: ${s.top_sellers.map((x) => `${x.host} (${fmt(x.endpoints)})`).join(', ')}.`] : []),
    ...(s.problems.length
      ? ['', `## Why some can't be paid on ${n.name}`, '', '| Problem | Endpoints |', '|---|---:|', ...s.problems.slice(0, 5).map((p) => `| ${p.problem.replace(/\|/g, '/')} | ${fmt(p.count)} |`)]
      : []),
    '',
    `The full list, payable or not and why: ${n.page}. Check your own endpoint for free: https://x402-doctor.fizzl.eu.`,
    '',
    `An agent can pay these with spending limits and a check before every payment: x402-safe-fetch (npm), which pays on ${n.name} too.`,
    '',
  ].join('\n');
}

function renderPosts(s) {
  const n = NETWORKS[s.network];
  const host = n.page.replace('https://', '');
  // X: at most 280 characters (a link counts as 23); drop the sellers line, then the change line, if they don't fit.
  const xLength = (t) => t.replace(/x402-doctor\.fizzl\.eu\S*/g, 'x'.repeat(23)).length;
  const change = [`+${fmt(s.added)} new`, ...(s.stopped != null ? [`${fmt(s.stopped)} stopped`] : [])].join(', ');
  const xLines = (withChange, withSellers) => [
    `x402 on ${n.name}, week ending ${s.date}:`,
    '',
    `${fmt(s.payable)} paid APIs from ${fmt(s.payable_sellers)} sellers accept ${n.name}. Median price ${usd(s.median_price_usd)}.`,
    ...(withChange ? [`This week: ${change}${s.new_sellers?.length ? `, new sellers ${list(s.new_sellers.slice(0, 2).map((x) => x.host))}` : ''}.`] : []),
    ...(withSellers && s.top_sellers.length ? [`Most endpoints: ${list(s.top_sellers.slice(0, withSellers).map((x) => x.host))}.`] : []),
    '',
    `Full list: ${host} ${n.tag} #x402`,
  ].join('\n');
  const x = [xLines(true, 3), xLines(true, 2), xLines(true, 0), xLines(false, 0)].find((t) => xLength(t) <= 280) ?? xLines(false, 0);

  const community = [
    `**x402 on ${n.name}, week ending ${s.date}** (every endpoint in the x402 Trust Index that accepts ${n.name}, checked daily without paying)`,
    '',
    `• ${payableLine(s)}`,
    `• ${changeLine(s).replace(/\*\*/g, '')}`,
    `• ${reachLine(s)[0].toUpperCase()}${reachLine(s).slice(1)}`,
    `• Median price: ${usd(s.median_price_usd)}`,
    ...(s.top_sellers.length ? [`• Most endpoints: ${s.top_sellers.map((x) => `${x.host} (${fmt(x.endpoints)})`).join(', ')}`] : []),
    ...(s.problems.length ? [`• Not payable on ${n.name}: ${fmt(s.problems.reduce((a, p) => a + p.count, 0))} (top reason: ${s.problems[0].problem})`] : []),
    '',
    `Full list: ${n.page}`,
    'Selling over x402? Check your endpoint for free: https://x402-doctor.fizzl.eu',
  ].join('\n');

  return { x, x_length: xLength(x), community };
}

function networkDigest(index, family, previous = null) {
  const { stats, snapshot } = digestStats(index, family, previous);
  return { stats, snapshot, markdown: renderMarkdown(stats), posts: renderPosts(stats) };
}

module.exports = { networkDigest, digestStats, networkRows, renderMarkdown, renderPosts, NETWORKS };
