// Weekly x402 health report, from the Trust Index (the daily read-only scan
// of every resource in the CDP Bazaar, see lib/trust-scan.js).
//
// weeklyReport(index) returns { stats, markdown, posts }: the numbers, a
// report to publish, and ready-to-post texts (X, Discord, Reddit) that a
// person reviews and sends. Aggregates only: the report never names a seller
// or host, so it reads as a health check of the ecosystem, not a shame list.

const { testByAddress } = require('./jev-triage');

const WINDOW_DAYS = 7;
// One host (a template farm can list tens of thousands of endpoints) with at least this share of the endpoints
// checked moves the totals by itself, up or down: the report then also gives the numbers without it.
const LARGEST_HOST_SHARE = 0.2;
const LARGEST_HOST_MIN = 1000;
const PAYABLE = new Set(['g', 'c']);
const REPORT_URL = 'https://x402-doctor.fizzl.eu/trust';

// Why a payment would fail or needs care, and the fix, per preflight reason code.
const REASONS = {
  no_402: { why: "don't answer 402 at all, so there is nothing to pay", short: "don't answer 402", fix: 'make the listed route answer 402 (a moved or renamed endpoint stays listed under its old URL until a payment goes through the new one)' },
  custom_scheme_only: { why: "offer only a payment scheme standard x402 clients don't pay", short: 'use only a custom scheme', fix: 'add an "exact" option next to it (an EIP-3009 transfer is "exact", not "eip3009")' },
  nevermined_plan: { why: 'sell only through a Nevermined plan, which standard x402 clients cannot pay', short: "are Nevermined plans only", fix: 'add an "exact" option next to the plan if standard x402 agents should pay too' },
  testnet_only: { why: 'offer only testnet payment options', short: "are testnet only", fix: 'add a mainnet option (for example Base, eip155:8453) or delist the test endpoint' },
  resource_mismatch: { why: 'name another URL in their 402 than the one requested', short: "name the wrong URL in their 402", fix: 'build resource.url from your public origin (behind a TLS proxy: trust proxy, so it stays https)' },
  unknown_asset: { why: "ask to be paid in a token that isn't a known USDC contract", short: "ask for a non-USDC token", fix: "use the network's USDC contract as the asset" },
  invalid_challenge: { why: 'answer 402 without a valid x402 challenge', short: "send a broken 402", fix: 'send the PaymentRequired object (base64 JSON in the PAYMENT-REQUIRED header, mirrored in the body)' },
  no_payable_option: { why: 'list payment options that would all fail', short: "offer no working payment option", fix: 'fix the blocking problem per option (network name, payTo, amount in atomic units)' },
  price_above_advertised: { why: 'charge more than their OpenAPI advertises', short: "charge more than advertised", fix: 'keep the price in openapi.json in step with the 402' },
  price_far_above_advertised: { why: 'charge 10 times what their OpenAPI advertises or more', short: "charge 10x what they advertise", fix: 'check the amount in atomic units, and keep the price in openapi.json in step with the 402' },
  suspicious_amount: { why: 'write the amount as dollars ("0.01") instead of atomic units', short: "write dollars instead of atomic units", fix: 'use atomic units: "10000" is $0.01 USDC' },
  not_https: { why: 'are served over plain http', short: "are plain http", fix: 'serve the endpoint over https' },
  unreliable_history: { why: 'were payable on only some of the recent daily scans', short: "are often down", fix: 'check uptime and cold starts' },
  payto_sanctioned: { why: 'pay out to an address on the OFAC SDN sanctions list', short: 'pay out to a sanctioned address', fix: 'use a payout address that is not on the SDN list; buyers are refused until then' },
  payto_burn: { why: 'pay out to the zero address or another burn address, a placeholder left in the config', short: 'pay out to a burn address', fix: 'set payTo to the wallet you want to be paid in' },
  unreachable: { why: 'timed out or could not be reached', short: "are unreachable", fix: 'check that the host is up and answers within 10 seconds' },
  server_error: { why: 'answered with a server error (5xx): down or failing', short: 'answer with a server error', fix: 'check the server and its hosting (behind Cloudflare, a 52x or 530 means Cloudflare could not reach your origin)' },
  // MPP (Stripe + Tempo, WWW-Authenticate: Payment) endpoints from the MPP directory:
  mpp_no_expires: { why: 'send an MPP challenge without an expiry', short: "send MPP challenges without an expiry", fix: 'set expires on each challenge (a few minutes ahead), so a captured challenge cannot be replayed later' },
  mpp_realm_mismatch: { why: "name another host as the MPP realm than the one they're served on", short: "name the wrong MPP realm", fix: 'set realm to the public host name of the endpoint' },
  mpp_expired: { why: 'send an MPP challenge that has already expired', short: "send expired MPP challenges", fix: 'compute expires per request instead of once at startup' },
  mpp_bad_fields: { why: 'send an MPP challenge with missing or malformed fields', short: "send broken MPP challenges", fix: 'send id, realm, method, intent and request as the MPP spec describes (mppx does this for you)' },
  mpp_challenge_unreadable: { why: 'answer 402 with an MPP header that cannot be read', short: "send unreadable MPP challenges", fix: 'send WWW-Authenticate: Payment with quoted parameters (mppx does this for you)' },
  rate_limited: { why: 'rate-limited the daily check', short: "rate-limit agents", fix: 'answer the 402 challenge before the rate limit, so agents can see the price' },
};
const readable = (code) => ({ why: String(code).replace(/_/g, ' '), fix: '' });
const PROTOCOL_NAMES = { x402: 'x402', mpp: 'MPP' };

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

// The history string h is aligned to the end of index.days (older letters may be missing).
function letterAt(r, days, i) {
  const offset = days.length - r.h.length;
  return i - offset >= 0 ? r.h[i - offset] : '-';
}

function weeklyStats(index) {
  const days = index.days || [];
  const last = days.length - 1;
  if (last < 0) throw new Error('empty index');
  const first = Math.max(0, days.length - WINDOW_DAYS);
  const resources = Object.values(index.resources || {});

  const latest = { checked: 0, go: 0, caution: 0, no_go: 0, unreachable: 0 };
  const start = { checked: 0, payable: 0 };
  const reasons = {};
  const hosts = new Set();
  const payableHosts = new Set();
  const networks = {};
  const prices = [];
  let broke = 0;
  let fixed = 0;
  let added = 0;
  let flaky = 0;
  // Test, staging and tunnel endpoints (staging., testnet, ngrok, Vercel previews …) are counted apart:
  // they are not services anyone sells, and they would pull the cautions up.
  const test = { resources: 0, hosts: new Set() };
  // Per protocol: Bazaar resources speak x402; entries from the MPP directory carry p: 'mpp'.
  const protocols = {};
  // MPP endpoints that check their input before asking for payment: not judged, counted apart.
  let needsInput = 0;
  // Per host, what it adds to the totals, to give them without a host that dominates (see LARGEST_HOST_SHARE).
  const byHost = new Map();

  for (const r of resources) {
    const now = letterAt(r, days, last);
    const then = letterAt(r, days, first);
    if (then !== '-') {
      start.checked++;
      if (PAYABLE.has(then)) start.payable++;
    }
    if (now === '-') { if (r.last?.verdict === 'needs_input') needsInput++; continue; }
    if (testByAddress(r.url)) { test.resources++; const o = originOf(r.url); if (o) test.hosts.add(o); continue; }

    latest.checked++;
    const proto = protocols[r.p || 'x402'] ||= { resources: 0, clean: 0, payable: 0 };
    proto.resources++;
    if (now === 'g') proto.clean++;
    if (PAYABLE.has(now)) proto.payable++;
    const origin = originOf(r.url);
    if (origin) hosts.add(origin);
    if (now === 'g') latest.go++;
    else if (now === 'c') latest.caution++;
    else if (now === 'n') latest.no_go++;
    else latest.unreachable++;
    const host = origin && (byHost.get(origin) || byHost.set(origin, { checked: 0, go: 0, caution: 0, no_go: 0, broke: 0, fixed: 0, reasons: {} }).get(origin));
    if (host) {
      host.checked++;
      if (now === 'g') host.go++;
      else if (now === 'c') host.caution++;
      else host.no_go++;
    }
    if (now !== 'g') {
      for (const code of (r.last && r.last.codes) || (now === 'x' ? ['unreachable'] : [])) {
        reasons[code] = (reasons[code] || 0) + 1;
        if (host) host.reasons[code] = (host.reasons[code] || 0) + 1;
      }
    }

    if (PAYABLE.has(now)) {
      if (origin) payableHosts.add(origin);
      for (const n of (r.last && r.last.networks) || []) networks[n] = (networks[n] || 0) + 1;
      if (typeof r.last?.price_usd === 'number') prices.push(r.last.price_usd);
    }

    // This week: letters in the window before today.
    const before = [];
    for (let i = first; i < last; i++) {
      const c = letterAt(r, days, i);
      if (c !== '-') before.push(c);
    }
    if (before.length === 0) {
      if (last > first) added++; // first seen today, although earlier days in the window were scanned
    } else {
      const wasPayable = before.some((c) => PAYABLE.has(c));
      if (!PAYABLE.has(now) && wasPayable) { broke++; if (host) host.broke++; }
      if (PAYABLE.has(now) && PAYABLE.has(before[0]) === false) { fixed++; if (host) host.fixed++; }
      // Flaky: switched between payable and not at least twice this week.
      const seen = [...before, now].map((c) => PAYABLE.has(c));
      if (seen.filter((ok, i) => i > 0 && ok !== seen[i - 1]).length >= 2) flaky++;
    }
  }

  prices.sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const payable = latest.go + latest.caution;
  const largest = largestHost(byHost, latest, reasons, { broke, fixed });
  return {
    window: { from: days[first], to: days[last], days: last - first + 1 },
    resources: latest.checked,
    hosts: hosts.size,
    payable,
    payable_pct: pct(payable, latest.checked),
    clean: latest.go,
    clean_pct: pct(latest.go, latest.checked),
    caution_pct: pct(latest.caution, latest.checked),
    payable_pct_week_start: start.checked ? pct(start.payable, start.checked) : null,
    no_go: latest.no_go + latest.unreachable,
    no_go_pct: pct(latest.no_go + latest.unreachable, latest.checked),
    caution: latest.caution,
    hosts_with_payable: payableHosts.size,
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count, ...(REASONS[code] || readable(code)) })),
    networks: Object.entries(networks).sort((a, b) => b[1] - a[1]).map(([network, count]) => ({ network, count, pct: pct(count, payable) })),
    median_price_usd: median,
    this_week: { broke, fixed, added, flaky },
    left_out_test: { resources: test.resources, hosts: test.hosts.size },
    not_judged_needs_input: needsInput,
    protocols: Object.entries(protocols).sort((a, b) => b[1].resources - a[1].resources).map(([protocol, p]) => ({ protocol, resources: p.resources, clean_pct: pct(p.clean, p.resources), payable_pct: pct(p.payable, p.resources) })),
    ...(largest ? { largest_host: largest } : {}),
  };
}

// The host with the most endpoints checked today, when it is LARGEST_HOST_SHARE of them or more: its share, how it
// did, and the totals without it. Never named: the report counts, it doesn't point.
function largestHost(byHost, latest, reasons, { broke, fixed }) {
  let top = null;
  for (const h of byHost.values()) if (!top || h.checked > top.checked) top = h;
  if (!top || top.checked < LARGEST_HOST_MIN || top.checked < latest.checked * LARGEST_HOST_SHARE) return null;
  const rest = latest.checked - top.checked;
  const withoutReasons = Object.entries(reasons)
    .map(([code, count]) => [code, count - (top.reasons[code] || 0)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({ code, count, ...(REASONS[code] || readable(code)) }));
  const topReason = Object.entries(top.reasons).sort((a, b) => b[1] - a[1])[0];
  return {
    resources: top.checked,
    share_pct: pct(top.checked, latest.checked),
    payable_pct: pct(top.go + top.caution, top.checked),
    // Down: nine in ten of its endpoints could not be paid today.
    down: top.no_go >= top.checked * 0.9,
    reason: topReason ? { code: topReason[0], ...(REASONS[topReason[0]] || readable(topReason[0])) } : null,
    broke: top.broke,
    without: {
      resources: rest,
      clean_pct: pct(latest.go - top.go, rest),
      caution_pct: pct(latest.caution - top.caution, rest),
      no_go_pct: pct(latest.no_go + latest.unreachable - top.no_go, rest),
      broke: broke - top.broke,
      fixed: fixed - top.fixed,
      reasons: withoutReasons,
    },
  };
}

// One sentence on the host that dominates, or null: "One host with 15,562 endpoints (33.5% of those checked) could not
// be paid on 2026-10-18 (answer with a server error). Without it: …".
function largestHostLine(s, { bold = false, week = true } = {}) {
  const l = s.largest_host;
  if (!l) return null;
  const b = (t) => (bold ? `**${t}**` : t);
  const how = l.down ? `could not be paid on ${s.window.to}${l.reason ? ` (${l.reason.short || l.reason.why})` : ''}` : `was ${l.payable_pct}% payable on ${s.window.to}`;
  return `One host with ${fmt(l.resources)} endpoints (${l.share_pct}% of those checked) ${how}, so it moves the totals by itself. Without it: ${b(`${l.without.clean_pct}%`)} clean, ${l.without.caution_pct}% with a caution, ${l.without.no_go_pct}% not payable, of ${fmt(l.without.resources)} resources${week && l.broke ? `; ${fmt(l.without.broke)} stopped being payable this week` : ''}.`;
}

const NETWORK_NAMES = { 'eip155:8453': 'Base', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana', 'eip155:137': 'Polygon', 'eip155:42161': 'Arbitrum', 'eip155:84532': 'Base Sepolia', 'eip155:43114': 'Avalanche', 'eip155:10': 'Optimism' };
// One line per protocol, only when more than one was checked: "x402 35,306 (93.9% clean), MPP 412 (80% clean)".
const protocolLine = (s) => (s.protocols?.length > 1 ? s.protocols.map((p) => `${PROTOCOL_NAMES[p.protocol] || p.protocol} ${fmt(p.resources)} (${p.clean_pct}% clean, ${p.payable_pct}% payable)`).join(', ') : null);
const hasMpp = (s) => Boolean(s.protocols?.some((p) => p.protocol === 'mpp'));
const netName = (n) => NETWORK_NAMES[n] || n;
const fmt = (n) => n.toLocaleString('en-US');
const usd = (n) => (n == null ? 'n/a' : `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`);

// The Fizzl endpoint monitor (Fizzl Pro on wallet.fizzl.eu): hourly checks, an alert on the phone (the wallet app), Telegram, Discord, Slack or a webhook when an endpoint breaks.
const MONITOR_URL = 'https://wallet.fizzl.eu';
function monitorLine(s, link) {
  const broke = s.largest_host ? s.largest_host.without.broke : s.this_week.broke;
  const lead = broke ? `${fmt(broke)} endpoint${broke === 1 ? '' : 's'} stopped being payable this week.` : 'Endpoints can stop being payable after a deploy or a config change.';
  return `${lead} Want an alert on your phone, Telegram, Discord or Slack if yours does? The Fizzl endpoint monitor checks it every hour, one endpoint free${link}`;
}

// The weekly spot-buy (lib/spot-buy.js, spot-data/latest.json) when it ran in this report's window: the scan reads
// the 402, the spot-buy pays and checks what came back. Null otherwise (no run yet, a dry run, or an older run).
function spotOf(report, window) {
  const sm = report?.summary;
  if (!sm?.live || !sm.bought || typeof report.date !== 'string') return null;
  const from = new Date(`${window.from}T00:00:00Z`).getTime() - 86400000; // the Sunday run before a Monday window
  const at = new Date(`${report.date}T00:00:00Z`).getTime();
  if (!(at >= from && at <= new Date(`${window.to}T00:00:00Z`).getTime())) return null;
  const o = sm.outcomes || {};
  return {
    date: report.date,
    bought: sm.bought,
    delivered: (o.delivered || 0) + (o.off_schema || 0),
    pct: sm.paid_and_delivered_pct,
    lost: sm.charged_without_answer?.count || 0,
    lost_usd: sm.charged_without_answer?.usd || 0,
    errors: (o.error_not_charged || 0) + (o.payment_rejected || 0),
  };
}

function spotLines(sp) {
  return [
    '## Paid and delivered (spot-buy)',
    '',
    `Reading the 402 only says a payment would settle. On ${sp.date} we bought ${fmt(sp.bought)} random endpoints that were payable here (one per seller, at most $0.05 each, USDC on Base) and checked what came back:`,
    '',
    `- **${sp.pct}%** paid and delivered (${fmt(sp.delivered)} of ${fmt(sp.bought)}).`,
    `- **${fmt(sp.lost)}** took the money without an answer${sp.lost ? ` (${usd(sp.lost_usd)} in total)` : ''}.`,
    `- **${fmt(sp.errors)}** answered with an error after payment, without charging.`,
    '',
    `Every purchase: ${REPORT_URL}`,
    '',
  ];
}

function renderMarkdown(s) {
  const trend = s.payable_pct_week_start == null ? '' : ` (${s.window.from}: ${s.payable_pct_week_start}%)`;
  const lines = [
    `# x402 health, week ending ${s.window.to}`,
    '',
    `Every resource in the CDP Bazaar${hasMpp(s) ? ' and the MPP directory' : ''}, checked daily the way a paying agent would (the 402 challenge only, never paid). Window: ${s.window.from} to ${s.window.to} (${s.window.days} days).`,
    '',
    '## The numbers',
    '',
    `- **${fmt(s.resources)}** resources on **${fmt(s.hosts)}** hosts were checked on ${s.window.to}.`,
    `- **${s.clean_pct}%** were clean: an agent could pay them without a second thought.`,
    `- **${s.caution_pct}%** (${fmt(s.caution)}) answered with a caution: testnet only, an unknown token, a URL mismatch and the like.`,
    `- **${s.no_go_pct}%** (${fmt(s.no_go)}) could not be paid at all. Payable, cautions included: ${s.payable_pct}%${trend}.`,
    `- This week: **${fmt(s.this_week.broke)}** stopped being payable, **${fmt(s.this_week.fixed)}** were fixed, **${fmt(s.this_week.flaky)}** went back and forth${s.this_week.added ? `, **${fmt(s.this_week.added)}** were new` : ''}.`,
    `- Median price of a payable call: **${usd(s.median_price_usd)}**.`,
    ...(protocolLine(s) ? [`- By protocol: ${protocolLine(s)}. MPP endpoints come from the MPP directory (Stripe + Tempo).`] : []),
    ...(s.not_judged_needs_input ? [`- Not counted: **${fmt(s.not_judged_needs_input)}** endpoints without example input to judge them by: MPP endpoints that check their input before asking for payment (for example "symbol is required"), and listed URL templates (/wallet/:address) whose listing gives no example value.`] : []),
    ...(s.left_out_test?.resources ? [`- Left out: **${fmt(s.left_out_test.resources)}** test, staging or tunnel endpoints on ${fmt(s.left_out_test.hosts)} hosts (addresses such as staging., sandbox., testnet, ngrok or Vercel previews).`] : []),
    ...(largestHostLine(s, { bold: true }) ? [`- ${largestHostLine(s, { bold: true })}`] : []),
    '',
    ...(s.spot ? spotLines(s.spot) : []),
    '## Why payments would fail or need care',
    '',
    '| Reason | Resources | What to fix |',
    '|---|---:|---|',
    ...s.reasons.slice(0, 6).map((r) => `| ${r.why[0].toUpperCase()}${r.why.slice(1)} | ${fmt(r.count)} | ${r.fix} |`),
    '',
    '## Where payable resources accept payment',
    '',
    'A resource can accept several networks, so the shares add up to more than 100%.',
    '',
    ...s.networks.slice(0, 5).map((n) => `- ${netName(n.network)}: ${fmt(n.count)} (${n.pct}%)`),
    '',
    `Check your own endpoint for free, with a fix per problem: ${REPORT_URL.replace('/trust', '')}. The daily data behind this report: ${REPORT_URL}.`,
    '',
    monitorLine(s, `: ${MONITOR_URL}`),
    '',
  ];
  return lines.join('\n');
}

function renderPosts(s) {
  const l = s.largest_host;
  // With a host that dominates, the week is told without it (and the host in one line).
  const reasons = l ? l.without.reasons : s.reasons;
  const week = l ? { broke: l.without.broke, fixed: l.without.fixed } : s.this_week;
  const top = reasons[0];
  // X: at most 280 characters (a link counts as 23); drop the monitor line, then the weekly line, then the spot-buy
  // line, if they don't fit.
  const xLength = (t) => t.replace(/(x402-doctor|wallet)\.fizzl\.eu/g, 'x'.repeat(23)).length;
  const sp = s.spot;
  const xLines = (withWeek, withMonitor = false, withSpot = false) => [
    `x402 health, week ending ${s.window.to}:`,
    '',
    ...(l
      ? [`One host with ${fmt(l.resources)} endpoints ${l.down ? `couldn't be paid on ${s.window.to}` : `is ${l.share_pct}% of all`}. Without it: ${fmt(l.without.resources)} endpoints, ${l.without.clean_pct}% clean, ${l.without.caution_pct}% caution, ${l.without.no_go_pct}% not payable.`]
      : [`${fmt(s.resources)} Bazaar endpoints checked daily: ${s.clean_pct}% clean, ${s.caution_pct}% with a caution, ${s.no_go_pct}% not payable.`,
        ...(top ? [`#1 problem: ${fmt(top.count)} ${top.short || top.why}.`] : [])]),
    ...(withWeek ? [`This week ${fmt(week.broke)} broke, ${fmt(week.fixed)} got fixed.`] : []),
    ...(withSpot && sp ? [`We also bought ${fmt(sp.bought)} at random: ${sp.pct}% paid and delivered.`] : []),
    '',
    'Free check with a fix per problem: x402-doctor.fizzl.eu',
    ...(withMonitor ? ['Alert when yours breaks: wallet.fizzl.eu'] : []),
  ].join('\n');
  const x = [xLines(true, true, true), xLines(true, false, true), xLines(false, false, true), xLines(true, true), xLines(true), xLines(false)].find((t) => xLength(t) <= 280) ?? xLines(false);

  const community = [
    `**x402 health, week ending ${s.window.to}** (every CDP Bazaar${hasMpp(s) ? ' and MPP directory' : ''} resource, checked daily without paying)`,
    '',
    `• ${fmt(s.resources)} resources on ${fmt(s.hosts)} hosts: ${s.clean_pct}% clean, ${s.caution_pct}% with a caution, ${s.no_go_pct}% not payable`,
    ...(l ? [`• ${largestHostLine(s, { week: false })}`] : []),
    `• This week${l ? ' (without that host)' : ''}: ${fmt(week.broke)} stopped being payable, ${fmt(week.fixed)} were fixed`,
    ...reasons.slice(0, 3).map((r) => `• ${fmt(r.count)} ${r.why}. Fix: ${r.fix}`),
    `• Median price of a payable call: ${usd(s.median_price_usd)}`,
    ...(sp ? [`• Spot-buy: we bought ${fmt(sp.bought)} payable endpoints at random; ${sp.pct}% paid and delivered, ${fmt(sp.lost)} took the money without an answer`] : []),
    ...(protocolLine(s) ? [`• By protocol: ${protocolLine(s)}`] : []),
    ...(s.left_out_test?.resources ? [`• ${fmt(s.left_out_test.resources)} test/staging endpoints left out of these numbers`] : []),
    '',
    'Numbers only, no names. DM me your endpoint for a free full check.',
    monitorLine(s, `: ${MONITOR_URL.replace('https://', '')}`),
  ].join('\n');

  const reddit = [
    l
      ? `**Title:** x402 health, week ending ${s.window.to}: ${l.without.clean_pct}% of ${fmt(l.without.resources)} Bazaar endpoints clean, not counting one host with ${fmt(l.resources)} (${l.down ? 'down that day' : `${l.share_pct}% of all`})`
      : `**Title:** x402 health, week ending ${s.window.to}: ${s.clean_pct}% of ${fmt(s.resources)} Bazaar endpoints clean, ${s.no_go_pct}% not payable`,
    '',
    renderMarkdown(s).split('\n').slice(2).join('\n'),
  ].join('\n');

  return { x, x_length: xLength(x), discord: community, reddit };
}

function weeklyReport(index, { spot = null } = {}) {
  const stats = weeklyStats(index);
  const sp = spotOf(spot, stats.window);
  if (sp) stats.spot = sp;
  return { stats, markdown: renderMarkdown(stats), posts: renderPosts(stats) };
}

module.exports = { weeklyReport, weeklyStats, renderMarkdown, renderPosts, spotOf, REASONS, WINDOW_DAYS };
