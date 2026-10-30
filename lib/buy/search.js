// The inkoper's candidates for a need (buy-server.js): the wallet server's ranked search of the whole x402 Bazaar
// (wallet.fizzl.eu: ranked by meaning with TypeSafe Jev, with x402 Doctor's daily track record per seller), kept to
// what the inkoper may buy: payable in USDC on Base within the price cap, a track record of at least MIN_DAYS days
// payable on MIN_RATIO of them, relevant enough, and not the inkoper itself.
'use strict';

const SEARCH_URL = process.env.BUY_SEARCH_URL || 'https://wallet.fizzl.eu/api/public/services/search';
const MIN_DAYS = 3;
const MIN_RATIO = 0.8;
const MIN_RELEVANCE = 0.6;
const OWN_HOST = /(^|\.)buy\.fizzl\.eu$/i;

const baseUsdOf = (r) => (r.prices || []).find((p) => /^base$/i.test(p.network))?.usd ?? null;

// Why a search result is left out, or null when it may be bought.
function leftOut(r, capUsd) {
  let host;
  try { host = new URL(r.url).hostname; } catch { return 'invalid url'; }
  if (OWN_HOST.test(host)) return 'the inkoper itself';
  const usd = baseUsdOf(r);
  if (usd === null) return 'not payable in USDC on Base';
  if (!(usd > 0) || usd > capUsd) return `price $${usd} above the cap of $${capUsd}`;
  if (!r.record || r.record.days < MIN_DAYS) return 'no track record yet';
  if (r.record.ratio < MIN_RATIO) return `payable on only ${r.record.payableDays} of ${r.record.days} days`;
  if (typeof r.relevance === 'number' && r.relevance < MIN_RELEVANCE) return 'not what was asked';
  return null;
}

// Where an example input goes when calling the API: a GET (or HEAD or DELETE) takes it as URL query parameters, the
// rest as a JSON body. Said in the pick, because agents passing a GET's example as a body lose it (Grok, 30 Oct 2026).
const exampleIn = (method) => (/^(GET|HEAD|DELETE)$/i.test(method || 'GET') ? 'query' : 'body');

// [{ url, method, description, example, example_in, price_usd, relevance, record }], best first: relevance and the track record in
// steps of 0.05 (0.99 and 1.0 count as equally relevant), then the cheapest, so between equals the inkoper keeps more of
// its $0.02 (on 23 Oct 2026 it picked a $0.01 BTC price at relevance 1 over $0.001 ones at 0.99). Sellers with a
// recent strike (lib/buy/strikes.js: paid, no usable answer) go last.
// The search ranks the whole catalog by meaning and can take 10–20 s on a cold cache (the first pick on 23 Oct 2026
// timed out and answered "internal error"): a timeout, a network error or a 5xx gets one more try, then a 503 that
// says so.
const step = (x) => Math.round((x ?? 0) / 0.05);
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

// What the catalog is searched with. A web address in the need names the thing to work on, not the kind of service:
// "is google.com up" found Google-related services and no uptime check (28 Oct 2026), while "is the website up" finds
// them. So addresses become "the website" (and e-mail addresses "an e-mail address") for the search only; the filler
// still gets the whole need, address included.
const EMAIL = /\b[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;
const WEB = /\b(?:https?:\/\/\S+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|dev|app|eu|nl|de|uk|co|xyz|info|me|tech|cloud|so|sh|gg|tv|us|fr|es|it)\b(?:\/\S*)?)/gi;
function searchQuery(need) {
  return String(need).replace(EMAIL, 'an e-mail address').replace(WEB, 'the website').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function candidatesFor(need, { capUsd, fetch: fetchImpl = globalThis.fetch, limit = 8, url = SEARCH_URL, timeoutMs = 20000, tries = 2, strikes = null } = {}) {
  const q = new URLSearchParams({ q: searchQuery(need), max: String(capUsd), net: 'eip155:8453' });
  let res = null;
  let why = '';
  for (let i = 0; i < tries && !res; i++) {
    try {
      const r = await fetchImpl(`${url}?${q}`, { headers: { accept: 'application/json', 'user-agent': 'fizzl-buy/1.0 (+https://buy.fizzl.eu)' }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) res = r;
      else { why = `HTTP ${r.status}`; if (r.status < 500) break; }
    } catch (err) {
      why = err.name === 'TimeoutError' ? 'no answer in time' : err.message;
    }
  }
  if (!res) throw Object.assign(new Error(`The catalog search failed (${why}); try again in a minute. Nothing was charged.`), { status: 503 });
  const results = (await res.json())?.results || [];
  return results
    .filter((r) => !leftOut(r, capUsd))
    .map((r) => ({ url: r.url, method: r.method || null, description: String(r.description || '').slice(0, 500), example: r.example ?? null, ...(r.example != null ? { example_in: exampleIn(r.method) } : {}), price_usd: baseUsdOf(r), relevance: r.relevance ?? null, record: r.record }))
    .sort((a, b) => step(b.relevance) - step(a.relevance) || step(b.record.ratio) - step(a.record.ratio) || a.price_usd - b.price_usd || (b.relevance ?? 0) - (a.relevance ?? 0))
    .sort((a, b) => Number(Boolean(strikes?.has(hostOf(a.url)))) - Number(Boolean(strikes?.has(hostOf(b.url)))))
    .slice(0, limit);
}

module.exports = { candidatesFor, searchQuery, leftOut, baseUsdOf, SEARCH_URL, MIN_DAYS, MIN_RATIO, MIN_RELEVANCE };
