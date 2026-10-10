// Link previews for the Doctor's pages: the Open Graph and Twitter card tags (title, description, the og.jpg card)
// that X, LinkedIn, Farcaster and chat apps read when someone shares a link. The pages are static files without
// them; this adds them before </head> when the page has none, with the page's own <title> and description unless
// a fresher description is given (the Trust Index puts in today's numbers). Files are read once per process.
'use strict';

const fs = require('fs');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function createPageMeta({ origin = 'https://x402-doctor.fizzl.eu', image = `${origin}/og.jpg`, read = (file) => fs.readFileSync(file, 'utf8') } = {}) {
  const cache = new Map();

  // The page's HTML with preview tags. path: the public path (for og:url); description overrides the page's own.
  function render(file, { path = '/', description } = {}) {
    if (!cache.has(file)) cache.set(file, read(file));
    const html = cache.get(file);
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

module.exports = { createPageMeta, trustDescription };
