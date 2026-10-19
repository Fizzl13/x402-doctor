// Link previews for the Doctor's pages: the Open Graph and Twitter card tags (title, description, the og.jpg card)
// that X, LinkedIn, Farcaster and chat apps read when someone shares a link. The pages are static files without
// them; this adds them before </head> when the page has none, with the page's own <title> and description unless
// a fresher description is given (the Trust Index puts in today's numbers). Files are read once per process.
//
// The Trust Index pages load their numbers in the browser, and AI crawlers don't run scripts: `fill` puts today's
// numbers in the HTML itself (the page's script later writes the same numbers).
'use strict';

const fs = require('fs');
const { NETWORKS } = require('./networks');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function createPageMeta({ origin = 'https://x402-doctor.fizzl.eu', image = `${origin}/og.jpg`, read = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  const cache = new Map();

  // The page's HTML with preview tags. path: the public path (for og:url); description overrides the page's own;
  // fill: [placeholder, html] pairs, each replacing the first remaining occurrence of its placeholder.
  function render(file, { path = '/', description, fill = [] } = {}) {
    if (!cache.has(file)) cache.set(file, read(file));
    let html = cache.get(file);
    for (const [placeholder, value] of fill || []) html = html.replace(placeholder, () => value);
    if (/property=["']og:title["']/i.test(html)) return html;
    const title = unesc(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? 'x402 Doctor');
    const desc = description || unesc(html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] ?? '');
    const tags = [
      ['property', 'og:type', 'website'],
      ['property', 'og:site_name', 'fizzl'],
      ['property', 'og:url', `${origin}${path}`],
      ['property', 'og:title', title],
      ['property', 'og:description', desc],
      ['property', 'og:image', image],
      ['property', 'og:image:width', '1200'],
      ['property', 'og:image:height', '630'],
      ['name', 'twitter:card', 'summary_large_image'],
      ['name', 'twitter:title', title],
      ['name', 'twitter:description', desc],
      ['name', 'twitter:image', image],
    ].map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join('\n');
    return html.replace(/<\/head>/i, `${tags}\n</head>`);
  }

  return { render };
}

// Today's Trust Index numbers as a one-line description, or null while the index is loading.
function trustDescription(summary) {
  const s = summary?.services;
  if (!s?.payable_endpoints) return null;
  const n = (x) => Number(x).toLocaleString('en-US');
  return `${n(s.payable_endpoints)} payable x402 endpoints, but only ${n(s.services)} distinct services from ${n(s.sellers)} sellers. Every one checked daily: would a payment settle today, and how often did it over 30 days.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-10-18' -> '18 Oct 2026', as the pages' scripts write it.
const scanDate = (day) => { const [y, m, d] = String(day).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const n = (x) => Number(x).toLocaleString('en-US');

// The sentence after the /trust headline when one seller is a large share of the scan (summary.largest_host), the same
// words the page's script writes: the share an agent could pay without that seller. '' otherwise.
function largestLine(summary) {
  const h = summary?.largest_host;
  const w = h?.latest_without;
  if (!w) return '';
  const rest = w.go + w.caution + w.no_go + w.unreachable;
  if (!rest) return '';
  const how = h.down ? `One seller with ${n(h.endpoints)} of them (${h.share_pct}%) could not be paid in this scan` : `One seller has ${n(h.endpoints)} of them (${h.share_pct}%)`;
  return ` ${how}; without it, an agent could pay ${Math.round(((w.go + w.caution) / rest) * 100)}% of the other ${n(rest)}.`;
}

// The /trust headline for today's scan, the same sentence the page's script writes, and the Dataset JSON-LD's
// dateModified and temporalCoverage (the days in the index), for search engines; [] while the index is loading.
function trustFill(summary) {
  const l = summary?.latest;
  const day = summary?.daily?.[summary.daily.length - 1]?.date;
  const checked = l ? l.go + l.caution + l.no_go + l.unreachable : 0;
  if (!checked || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return [];
  const pct = Math.round(((l.go + l.caution) / checked) * 100);
  const first = summary.daily[0].date;
  const faq = trustFaq(summary, { day, checked });
  return [
    ["Loading today's scan…", `In the scan of ${scanDate(day)}, an agent could pay <strong>${pct}%</strong> of the <strong>${n(checked)}</strong> paid services checked (x402 and MPP) without a failed payment.${largestLine(summary)}`],
    ['"isAccessibleForFree": true,', `"isAccessibleForFree": true,\n "dateModified": "${day}",\n "temporalCoverage": "${/^\d{4}-\d{2}-\d{2}$/.test(first) ? first : day}/${day}",`],
    ['<!--trust-faq-->', `<section class="faq">\n  <h2>Questions</h2>\n${faq.map(({ q, a }) => `  <h3>${esc(q)}</h3>\n  <p>${esc(a)}</p>`).join('\n')}\n  </section>`],
    ['<!--trust-faq-ld-->', `<script type="application/ld+json">\n${JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }).replace(/</g, '\\u003c')}\n</script>`],
  ];
}

// The /trust page's words for the scan's reason codes (public/trust.html REASON).
const REASONS = {
  no_402: "doesn't ask for payment at all (offline or broken)", resource_mismatch: 'charges for a different address than the one called',
  testnet_only: 'only accepts test money', unknown_asset: 'asks for an unknown token instead of USDC', price_above_advertised: 'charges more than it advertises',
  price_far_above_advertised: 'charges 10 times what it advertises or more', no_payable_option: 'no payment option that works',
  invalid_challenge: 'sends a broken payment request', suspicious_amount: 'the price looks wrong', server_error: 'server error (5xx)',
  mpp_realm_mismatch: 'MPP realm is another domain', mpp_no_expires: 'MPP challenge never expires', payto_sanctioned: 'pays out to an address on the OFAC sanctions list', payto_burn: 'pays out to the zero address or another burn address',
  nevermined_plan: 'paid only with a Nevermined plan, not by standard x402 clients',
  custom_scheme_only: "only a payment scheme standard x402 clients don't pay",
};

// The questions people ask an AI about x402, answered with today's scan: the visible FAQ and its FAQPage JSON-LD
// carry the same text.
function trustFaq(summary, { day, checked }) {
  const l = summary.latest;
  const date = scanDate(day);
  const payable = l.go + l.caution;
  const bp = summary.by_protocol || {};
  const split = bp.x402?.resources && bp.mpp?.resources ? ` (${n(bp.x402.resources)} x402 and ${n(bp.mpp.resources)} MPP)` : '';
  const s = summary.services || {};
  const services = s.services ? ` The ${n(payable)} payable ones are ${n(s.services)} distinct services from ${n(s.sellers)} sellers: a seller often lists the same API once per coin, city or ticker.` : '';
  const problems = (summary.reasons || []).filter((r) => REASONS[r.code]).slice(0, 3).map((r) => `${REASONS[r.code]} (${n(r.count)})`);
  const perName = new Map();
  for (const { network, endpoints } of summary.networks || []) {
    const info = NETWORKS[network];
    if (!info || info.testnet) continue;
    perName.set(info.name, (perName.get(info.name) || 0) + endpoints);
  }
  const nets = [...perName].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name} ${n(count)}`);
  const faq = [
    { q: 'How many paid x402 endpoints are there?', a: `In the scan of ${date}, x402 Doctor checked ${n(checked)} paid API endpoints${split} listed in the CDP Bazaar, Circle's Agent Marketplace, the MPP directory and other public indexes.${services}` },
    { q: 'What share of x402 endpoints can an AI agent actually pay?', a: `${Math.round((payable / checked) * 100)}% in the scan of ${date}: ${n(payable)} of ${n(checked)} endpoints would take a payment without failing (${n(l.go)} as listed, ${n(l.caution)} with a warning).${largestLine(summary)}${problems.length ? ` The most common problems: ${problems.join('; ')}.` : ''}` },
  ];
  if (nets.length) faq.push({ q: 'On which networks can AI agents pay x402 endpoints?', a: `Endpoints payable per network in the scan of ${date}: ${nets.join(', ')}. Most endpoints offer more than one network. Every endpoint per network, payable or not and why: x402-doctor.fizzl.eu/stellar, /algorand and /xrpl.` });
  faq.push({ q: 'Where can I get this data?', a: 'Free, without an API key: GET https://x402-doctor.fizzl.eu/api/trust?url=<endpoint> for one endpoint\'s 30-day record, GET /api/trust/summary for the totals, and the whole index as an open dataset on Hugging Face (huggingface.co/datasets/x402Fizzl/x402-trust-index, CC BY 4.0, updated daily). Before paying an endpoint, an agent can ask GET /api/v1/preflight?url=<endpoint> for go, caution or no_go ($0.001).' });
  return faq;
}

// The four numbers and the scan date of a network page (/stellar, /algorand, /xrpl) from trustIndex.byNetwork().
function networkFill(view) {
  const day = view?.days?.[view.days.length - 1];
  if (!view?.endpoints || !day) return [];
  const v = '<div class="v">…</div>';
  return [
    [v, `<div class="v">${n(view.endpoints)}</div>`],
    [v, `<div class="v">${n(view.payable_now)}</div>`],
    [v, `<div class="v">${n(view.sellers.length)}</div>`],
    [v, `<div class="v">${view.services == null ? '–' : n(view.services)}</div>`],
    ['<p class="note" id="updated"></p>', `<p class="note" id="updated">From the daily scan of ${day}.</p>`],
  ];
}

module.exports = { createPageMeta, trustDescription, trustFill, networkFill, scanDate };
