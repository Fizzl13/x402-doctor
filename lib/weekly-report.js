// Weekly x402 health report, from the Trust Index (the daily read-only scan
// of every resource in the CDP Bazaar, see lib/trust-scan.js).
//
// weeklyReport(index) returns { stats, markdown, posts }: the numbers, a
// report to publish, and ready-to-post texts (X, Discord, Reddit) that a
// person reviews and sends. Aggregates only: the report never names a seller
// or host, so it reads as a health check of the ecosystem, not a shame list.

const WINDOW_DAYS = 7;
const PAYABLE = new Set(['g', 'c']);
const REPORT_URL = 'https://x402-doctor.fizzl.eu/trust';

// Why a payment would fail or needs care, and the fix, per preflight reason code.
const REASONS = {
  no_402: { why: "don't answer 402 at all, so there is nothing to pay", short: "don't answer 402", fix: 'make the listed route answer 402 (a moved or renamed endpoint stays listed under its old URL until a payment goes through the new one)' },
  testnet_only: { why: 'offer only testnet payment options', short: "are testnet only", fix: 'add a mainnet option (for example Base, eip155:8453) or delist the test endpoint' },
  resource_mismatch: { why: 'name another URL in their 402 than the one requested', short: "name the wrong URL in their 402", fix: 'build resource.url from your public origin (behind a TLS proxy: trust proxy, so it stays https)' },
  unknown_asset: { why: "ask to be paid in a token that isn't a known USDC contract", short: "ask for a non-USDC token", fix: "use the network's USDC contract as the asset" },
  invalid_challenge: { why: 'answer 402 without a valid x402 challenge', short: "send a broken 402", fix: 'send the PaymentRequired object (base64 JSON in the PAYMENT-REQUIRED header, mirrored in the body)' },
  no_payable_option: { why: 'list payment options that would all fail', short: "offer no working payment option", fix: 'fix the blocking problem per option (network name, payTo, amount in atomic units)' },
  price_above_advertised: { why: 'charge more than their OpenAPI advertises', short: "charge more than advertised", fix: 'keep the price in openapi.json in step with the 402' },
  suspicious_amount: { why: 'write the amount as dollars ("0.01") instead of atomic units', short: "write dollars instead of atomic units", fix: 'use atomic units: "10000" is $0.01 USDC' },
  not_https: { why: 'are served over plain http', short: "are plain http", fix: 'serve the endpoint over https' },
  unreliable_history: { why: 'were payable on only some of the recent daily scans', short: "are often down", fix: 'check uptime and cold starts' },
  unreachable: { why: 'timed out or could not be reached', short: "are unreachable", fix: 'check that the host is up and answers within 10 seconds' },
};

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

  for (const r of resources) {
    const now = letterAt(r, days, last);
    const then = letterAt(r, days, first);
    if (then !== '-') {
      start.checked++;
      if (PAYABLE.has(then)) start.payable++;
    }
    if (now === '-') continue;

    latest.checked++;
    const origin = originOf(r.url);
    if (origin) hosts.add(origin);
    if (now === 'g') latest.go++;
    else if (now === 'c') latest.caution++;
    else if (now === 'n') latest.no_go++;
    else latest.unreachable++;
    if (now !== 'g') for (const code of (r.last && r.last.codes) || (now === 'x' ? ['unreachable'] : [])) reasons[code] = (reasons[code] || 0) + 1;

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
      if (!PAYABLE.has(now) && wasPayable) broke++;
      if (PAYABLE.has(now) && PAYABLE.has(before[0]) === false) fixed++;
      // Flaky: switched between payable and not at least twice this week.
      const seen = [...before, now].map((c) => PAYABLE.has(c));
      if (seen.filter((ok, i) => i > 0 && ok !== seen[i - 1]).length >= 2) flaky++;
    }
  }

  prices.sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const payable = latest.go + latest.caution;
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
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count, ...(REASONS[code] || { why: code, fix: '' }) })),
    networks: Object.entries(networks).sort((a, b) => b[1] - a[1]).map(([network, count]) => ({ network, count, pct: pct(count, payable) })),
    median_price_usd: median,
    this_week: { broke, fixed, added, flaky },
  };
}

const NETWORK_NAMES = { 'eip155:8453': 'Base', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana', 'eip155:137': 'Polygon', 'eip155:42161': 'Arbitrum', 'eip155:84532': 'Base Sepolia', 'eip155:43114': 'Avalanche', 'eip155:10': 'Optimism' };
const netName = (n) => NETWORK_NAMES[n] || n;
const fmt = (n) => n.toLocaleString('en-US');
const usd = (n) => (n == null ? 'n/a' : `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`);

// The Fizzl endpoint monitor (Fizzl Pro on wallet.fizzl.eu): hourly checks, an alert on the phone (the wallet app), Telegram, Discord, Slack or a webhook when an endpoint breaks.
const MONITOR_URL = 'https://wallet.fizzl.eu';
function monitorLine(s, link) {
  const lead = s.this_week.broke ? `${fmt(s.this_week.broke)} endpoint${s.this_week.broke === 1 ? '' : 's'} stopped being payable this week.` : 'Endpoints can stop being payable after a deploy or a config change.';
  return `${lead} Want an alert on your phone, Telegram, Discord or Slack if yours does? The Fizzl endpoint monitor checks it every hour, one endpoint free${link}`;
}

function renderMarkdown(s) {
  const trend = s.payable_pct_week_start == null ? '' : ` (${s.window.from}: ${s.payable_pct_week_start}%)`;
  const lines = [
    `# x402 health, week ending ${s.window.to}`,
    '',
    `Every resource in the CDP Bazaar, checked daily the way a paying agent would (the 402 challenge only, never paid). Window: ${s.window.from} to ${s.window.to} (${s.window.days} days).`,
    '',
    '## The numbers',
    '',
    `- **${fmt(s.resources)}** resources on **${fmt(s.hosts)}** hosts were checked on ${s.window.to}.`,
    `- **${s.clean_pct}%** were clean: an agent could pay them without a second thought.`,
    `- **${s.caution_pct}%** (${fmt(s.caution)}) answered with a caution: testnet only, an unknown token, a URL mismatch and the like.`,
    `- **${s.no_go_pct}%** (${fmt(s.no_go)}) could not be paid at all. Payable, cautions included: ${s.payable_pct}%${trend}.`,
    `- This week: **${fmt(s.this_week.broke)}** stopped being payable, **${fmt(s.this_week.fixed)}** were fixed, **${fmt(s.this_week.flaky)}** went back and forth${s.this_week.added ? `, **${fmt(s.this_week.added)}** were new` : ''}.`,
    `- Median price of a payable call: **${usd(s.median_price_usd)}**.`,
    '',
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
  const top = s.reasons[0];
  // X: at most 280 characters (a link counts as 23); drop the monitor line, then the weekly line, if they don't fit.
  const xLength = (t) => t.replace(/(x402-doctor|wallet)\.fizzl\.eu/g, 'x'.repeat(23)).length;
  const xLines = (withWeek, withMonitor = false) => [
    `x402 health, week ending ${s.window.to}:`,
    '',
    `${fmt(s.resources)} Bazaar endpoints checked daily: ${s.clean_pct}% clean, ${s.caution_pct}% with a caution, ${s.no_go_pct}% not payable.`,
    ...(top ? [`#1 problem: ${fmt(top.count)} ${top.short || top.why}.`] : []),
    ...(withWeek ? [`This week ${fmt(s.this_week.broke)} broke, ${fmt(s.this_week.fixed)} got fixed.`] : []),
    '',
    'Free check with a fix per problem: x402-doctor.fizzl.eu',
    ...(withMonitor ? ['Alert when yours breaks: wallet.fizzl.eu'] : []),
  ].join('\n');
  const x = [xLines(true, true), xLines(true), xLines(false)].find((t) => xLength(t) <= 280) ?? xLines(false);

  const community = [
    `**x402 health, week ending ${s.window.to}** (every CDP Bazaar resource, checked daily without paying)`,
    '',
    `• ${fmt(s.resources)} resources on ${fmt(s.hosts)} hosts: ${s.clean_pct}% clean, ${s.caution_pct}% with a caution, ${s.no_go_pct}% not payable`,
    `• This week: ${fmt(s.this_week.broke)} stopped being payable, ${fmt(s.this_week.fixed)} were fixed`,
    ...s.reasons.slice(0, 3).map((r) => `• ${fmt(r.count)} ${r.why}. Fix: ${r.fix}`),
    `• Median price of a payable call: ${usd(s.median_price_usd)}`,
    '',
    'Numbers only, no names. DM me your endpoint for a free full check.',
    monitorLine(s, `: ${MONITOR_URL.replace('https://', '')}`),
  ].join('\n');

  const reddit = [
    `**Title:** x402 health, week ending ${s.window.to}: ${s.clean_pct}% of ${fmt(s.resources)} Bazaar endpoints clean, ${s.no_go_pct}% not payable`,
    '',
    renderMarkdown(s).split('\n').slice(2).join('\n'),
  ].join('\n');

  return { x, x_length: xLength(x), discord: community, reddit };
}

function weeklyReport(index) {
  const stats = weeklyStats(index);
  return { stats, markdown: renderMarkdown(stats), posts: renderPosts(stats) };
}

module.exports = { weeklyReport, weeklyStats, renderMarkdown, renderPosts, REASONS, WINDOW_DAYS };
