// market-digest.js
//
// Weekly x402 market digest (run with the weekly report): where agents' paid calls go, from the CDP Bazaar's
// 30-day counts per route (bazaar-index siteCalls) and the Trust Index's kinds of service (trustIndex.atlas()),
// with drafts for X and LinkedIn that a person reviews and posts.
//
// The headline is how much of the 30 days' calls sits on routes still paid this week: one campaign can make a
// kind of service look big long after it stopped (16 Oct 2026: one quest route was 97.6% of "wallets & on-chain
// data"). Routes paid many times per wallet (a quest, a bot or a few heavy users) are counted and described, never
// named; sellers are named only as risers in still-paid calls with ordinary calls per wallet. Week-over-week numbers come from last week's
// snapshot (marketDigest's `snapshot`, kept on the weekly-reports branch). The Bazaar's counts are rolling 30-day
// totals, so a weekly change is the week that came in minus the week that dropped out.

'use strict';

const { createHash } = require('crypto');
const { marketSummary } = require('./market-summary');

const ACTIVE_DAYS = 3; // bazaar-index ACTIVE_MS: a route is still paid while its last settled payment is this recent
const HEAVY_CALLS_PER_WALLET = 50; // a route paid this often per wallet: a quest, a bot or a few heavy users
const HEAVY_MIN_SHARE = 0.01; // ...listed when it is at least 1% of the market's calls
const HEAVY_LISTED = 6;
const RISER_MIN = 100; // still-paid calls a seller must have gained in a week to be named
const SNAPSHOT_SELLERS = 300;
const ATLAS = 'atlas.fizzl.eu';
const LAB = 'lab.fizzl.eu';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : '0');
const day = (iso) => (iso ? iso.slice(0, 10) : null);
const routeId = (route) => createHash('sha1').update(route).digest('hex').slice(0, 12); // the snapshot never names a route
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// map: trustIndex.atlas(); bazaar: bazaar-index siteCalls() ({ at, calls, active, payers, top });
// previous: last week's snapshot or null. Returns { stats, markdown, posts, snapshot }.
function marketDigest({ map, bazaar, previous = null }) {
  if (!bazaar?.active) throw new Error('the Bazaar index has no still-paid counts (lastCalledAt) yet');
  const summary = marketSummary(map, bazaar.calls, { active: bazaar.active, payers: bazaar.payers });
  if (!summary) throw new Error('no market summary: the Trust Index or the Bazaar is empty');
  const readAt = new Date(bazaar.at).toISOString();
  const kindOf = new Map(map.sellers.map((s) => [s[0], map.categories?.[s[1]]?.name || 'Other']));

  const kinds = summary.by_kind
    .filter((k) => k.calls_active > 0)
    .sort((a, b) => b.calls_active - a.calls_active)
    .map((k) => ({ id: k.id, name: k.name, calls: k.calls, calls_active: k.calls_active, share_active: pct(k.calls_active, summary.calls_active), top_seller_share: k.top_seller_share, payers: k.payers ?? null }));

  const heavy = (bazaar.top || [])
    .filter((r) => r.payers > 0 && r.calls / r.payers >= HEAVY_CALLS_PER_WALLET && r.calls >= HEAVY_MIN_SHARE * summary.calls_30d)
    .map((r) => {
      const id = routeId(r.route);
      return {
        id,
        kind: kindOf.get(r.site) || 'Other',
        calls: r.calls,
        wallets: r.payers,
        calls_per_wallet: Math.round(r.calls / r.payers),
        share_of_market: pct(r.calls, summary.calls_30d),
        last_paid: day(r.last),
        still_paid: Boolean(r.last && bazaar.at - Date.parse(r.last) <= ACTIVE_DAYS * 864e5),
        new: previous ? !(previous.heavy_routes || []).includes(id) : null,
      };
    });

  // Sellers by still-paid calls; risers only with last week's snapshot, and never a seller paid that often per wallet.
  const sellers = [...bazaar.active.entries()]
    .filter(([site]) => kindOf.has(site))
    .sort((a, b) => b[1] - a[1])
    .slice(0, SNAPSHOT_SELLERS)
    .map(([site, active]) => ({ site, active, calls: Number(bazaar.calls.get(site)) || 0, payers: Number(bazaar.payers?.get(site)) || 0 }));
  const risers = previous
    ? sellers
      .filter((s) => !s.payers || s.calls / s.payers < HEAVY_CALLS_PER_WALLET)
      .map((s) => ({ site: s.site, kind: kindOf.get(s.site), gained: s.active - (previous.sellers?.[s.site]?.active ?? 0), active: s.active }))
      .filter((s) => s.gained >= RISER_MIN)
      .sort((a, b) => b.gained - a.gained)
      .slice(0, 3)
    : [];

  const stats = {
    date: day(readAt),
    read_at: readAt,
    sellers: summary.sellers,
    calls_30d: summary.calls_30d,
    calls_active: summary.calls_active,
    active_pct: pct(summary.calls_active, summary.calls_30d),
    kinds,
    heavy_routes: heavy,
    risers,
    previous: previous ? { date: previous.date, calls_30d: previous.calls_30d, calls_active: previous.calls_active, active_pct: pct(previous.calls_active, previous.calls_30d) } : null,
  };
  const snapshot = {
    date: stats.date,
    read_at: readAt,
    calls_30d: stats.calls_30d,
    calls_active: stats.calls_active,
    kinds: Object.fromEntries(kinds.map((k) => [k.id, { calls: k.calls, calls_active: k.calls_active }])),
    sellers: Object.fromEntries(sellers.map((s) => [s.site, { active: s.active, calls: s.calls, payers: s.payers }])),
    heavy_routes: heavy.map((c) => c.id),
  };
  return { stats, markdown: renderMarkdown(stats), posts: renderPosts(stats), snapshot };
}

const heavyLine = (c) => `${c.kind}: ${fmt(c.calls)} paid calls from ${fmt(c.wallets)} wallets, ${fmt(c.calls_per_wallet)} per wallet (${c.share_of_market}% of the market)${c.still_paid ? ', still paid' : `, last paid ${c.last_paid}`}`;
const weekLine = (s) => {
  const d = s.calls_active - s.previous.calls_active;
  return `Week on week, still-paid calls went ${d >= 0 ? 'up' : 'down'} by ${fmt(Math.abs(d))} (${s.previous.active_pct}% → ${s.active_pct}% of the 30 days' calls).`;
};

function renderMarkdown(s) {
  const lines = [
    `# x402 market, week of ${s.date}`,
    '',
    `Where AI agents' paid calls go, from Coinbase's CDP Bazaar (30-day settled calls, unique payers and last paid call per route, read ${s.read_at.slice(0, 16).replace('T', ' ')} UTC) and x402 Doctor's Trust Index (${fmt(s.sellers)} sellers, their kind of service).`,
    '',
    `**${fmt(s.calls_active)} of ${fmt(s.calls_30d)} paid calls over 30 days (${s.active_pct}%) are on routes still paid in the last ${ACTIVE_DAYS} days.** The rest came from routes that stopped: often campaigns or quests that end.`,
    '',
    ...(s.previous ? [weekLine(s), ''] : []),
    '## Still paid, by kind of service',
    '',
    '| Kind | Still-paid calls | Share | All calls (30 days) | Largest seller\'s share |',
    '|---|---:|---:|---:|---:|',
    ...s.kinds.slice(0, 8).map((k) => `| ${k.name} | ${fmt(k.calls_active)} | ${k.share_active}% | ${fmt(k.calls)} | ${Math.round(k.top_seller_share * 100)}% |`),
    '',
    '## Routes paid many times per wallet',
    '',
    `Single routes paid ${HEAVY_CALLS_PER_WALLET}+ times per wallet, each at least ${HEAVY_MIN_SHARE * 100}% of the market's calls: a quest, a bot or a few heavy users. They can make a kind look big; they are counted here, not named.`,
    '',
    ...(s.heavy_routes.length ? s.heavy_routes.slice(0, HEAVY_LISTED).map((c) => `- ${heavyLine(c)}${c.new ? ' (new this week)' : ''}`) : ['- None this week.']),
    ...(s.heavy_routes.length > HEAVY_LISTED ? [`- and ${s.heavy_routes.length - HEAVY_LISTED} more`] : []),
    '',
    ...(s.risers.length ? ['## Rising', '', 'Sellers that gained the most still-paid calls since last week, with ordinary calls per wallet:', '', ...s.risers.map((r) => `- ${r.site} (${r.kind}): ${signed(r.gained)}`), ''] : []),
    '## How to read this',
    '',
    `The Bazaar counts settled calls per route over a rolling 30 days, so a weekly change is the week that came in minus the week that dropped out. Unique payers are per route; a wallet that paid two routes counts twice. Every seller as a live map: https://${ATLAS}. Each kind's largest-seller share: https://${LAB}.`,
    '',
  ];
  return lines.join('\n');
}

function renderPosts(s) {
  const xLength = (t) => t.replace(/(atlas|lab)\.fizzl\.eu/g, 'x'.repeat(23)).length;
  const big = [...s.heavy_routes].sort((a, b) => b.calls - a.calls)[0];
  const kindsLine = (n) => `Still paid, by kind: ${s.kinds.slice(0, n).map((k) => `${k.name} ${k.share_active}%`).join(', ')}.`;
  const xLines = (withRoute, withWeek, n) => [
    `x402 market, week of ${s.date}:`,
    '',
    `${fmt(s.calls_active)} of ${fmt(s.calls_30d)} paid calls in 30 days (${s.active_pct}%) are on routes still paid this week (CDP Bazaar).`,
    ...(withRoute && big ? [`One route (${big.kind}) had ${fmt(big.calls)} of all those calls, from ${fmt(big.wallets)} wallets${big.still_paid ? '' : `; last paid ${big.last_paid}`}.`] : []),
    ...(n ? [kindsLine(n)] : []),
    ...(withWeek && s.previous ? [`Week on week: ${signed(s.calls_active - s.previous.calls_active)} still-paid calls.`] : []),
    '',
    `Map: ${ATLAS}`,
  ].join('\n');
  // Prefer the biggest single route over the kinds: drop the week line, then kinds, before the route.
  const x = [[true, true, 3], [true, false, 3], [true, false, 2], [true, false, 1], [true, false, 0], [false, true, 3], [false, false, 3], [false, false, 2], [false, false, 0]]
    .map((a) => xLines(...a))
    .find((t) => xLength(t) <= 280) ?? xLines(false, false, 0);

  const linkedin = [
    `Where AI agents' money goes in x402, week of ${s.date}.`,
    '',
    `Coinbase's CDP Bazaar counted ${fmt(s.calls_30d)} paid calls over the last 30 days. ${fmt(s.calls_active)} of them (${s.active_pct}%) are on routes that were still paid in the last ${ACTIVE_DAYS} days; the rest came from routes that stopped, often campaigns or quests.`,
    ...(big ? ['', `The biggest single route this month: ${heavyLine(big)}. A few wallets paying many times can make a whole kind of service look big, so count wallets, not just calls.`] : []),
    '',
    `${kindsLine(4)}`,
    ...(s.risers.length ? ['', `Rising this week, in still-paid calls: ${list(s.risers.map((r) => `${r.site} (${signed(r.gained)})`))}.`] : []),
    ...(s.previous ? ['', weekLine(s)] : []),
    '',
    `Every seller as a live map: ${ATLAS}. Each kind's largest-seller share: ${LAB}. Data: CDP Bazaar (30-day settled calls, unique payers and last call per route), read ${s.date}.`,
  ].join('\n');

  return { x, x_length: xLength(x), linkedin };
}

module.exports = { marketDigest, renderMarkdown, renderPosts, HEAVY_CALLS_PER_WALLET, ACTIVE_DAYS };
