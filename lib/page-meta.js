// Link previews for the Doctor's pages: the Open Graph and Twitter card tags (title, description, the og.jpg card)
// that X, LinkedIn, Farcaster and chat apps read when someone shares a link. The pages are static files without
// them; this adds them before </head> when the page has none, with the page's own <title> and description unless
// a fresher description is given (the Trust Index puts in today's numbers). Files are read once per process.
//
// The Trust Index pages load their numbers in the browser, and AI crawlers don't run scripts: `fill` puts today's
// numbers in the HTML itself (the page's script later writes the same numbers).
'use strict';

const fs = require('fs');

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

// The /trust headline for today's scan, the same sentence the page's script writes; [] while the index is loading.
function trustFill(summary) {
  const l = summary?.latest;
  const day = summary?.daily?.[summary.daily.length - 1]?.date;
  const checked = l ? l.go + l.caution + l.no_go + l.unreachable : 0;
  if (!checked || !day) return [];
  const pct = Math.round(((l.go + l.caution) / checked) * 100);
  return [["Loading today's scan…", `In the scan of ${scanDate(day)}, an agent could pay <strong>${pct}%</strong> of the <strong>${n(checked)}</strong> paid services checked (x402 and MPP) without a failed payment.`]];
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
