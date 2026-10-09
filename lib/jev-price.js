// Is the price fair? An agent can't tell whether $0.50 for a call is normal or ten times what other sellers ask
// for the same thing. The Trust Index knows the prices of every scanned paid API; the hard part is which of them
// really do the same thing. Code finds candidates by shared words (trustIndex.similar), TypeSafe's Jev judges per
// candidate whether a buyer would be served just as well by it, and the median price of those that would is the
// comparison. Far above it adds a reason (info from 5x, caution from 20x) and names the cheaper alternatives; it
// never makes a verdict no_go: the price is the seller's choice, the agent decides whether it is worth it.
//
// Opt-in per caller (preflight({ price })): the paid preflight uses it, bulk scans don't. Answers are cached per
// description for a day. Off without TYPESAFE_API_KEY (JEV_CHECK=off turns it off again). Any failure (timeout,
// error, rate limit, too few comparable services) skips the check silently: the preflight stands as it was.
'use strict';

const API = 'https://api.typesafe.ai/v1/systemone';

const QUESTION = 'Would a buyer who wants what `target` offers be served just as well by `candidate`: the same kind of result for the same need? Sharing a topic is not enough (a token price feed does not replace a token safety check; a stock signal does not replace a crypto signal).';
const CRITERIA = { true: 'Same kind of service: it could replace the target', false: 'A different service, even if related' };

// How sure Jev must be that a candidate is the same kind of service, how many such services the comparison needs,
// and when a price is far enough above their median to say so. The absolute gap keeps cent-level prices quiet
// ($0.005 next to a $0.001 median is 5x but costs nothing worth a warning).
const SAME = 0.7;
const MIN_COMPARABLE = 5;
const INFO_RATIO = 5;
const INFO_GAP = 0.05;
const CAUTION_RATIO = 20;
const CAUTION_GAP = 0.25;

const round = (n) => Math.round(n * 1e6) / 1e6;
function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function createPriceCheck({ apiKey = process.env.TYPESAFE_API_KEY, trustIndex, fetch: fetchImpl = globalThis.fetch, timeoutMs = 3000, model = process.env.JEV_MODEL || 'jev-latest', ttlMs = 24 * 3600e3, max = 500, log = console } = {}) {
  const enabled = Boolean(apiKey) && Boolean(trustIndex?.similar) && process.env.JEV_CHECK !== 'off';
  const cache = new Map();

  // Which candidates are the same kind of service: one probability per candidate, or null when Jev failed.
  async function sameKind(host, description, candidates) {
    const questions = {};
    candidates.forEach((c, i) => {
      questions[`c${i}`] = {
        type: 'noul',
        instructions: { candidate: { host: c.host, description: c.description }, question: QUESTION },
        criteria: CRITERIA,
      };
    });
    try {
      const res = await fetchImpl(API, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: { target: { host, description } }, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { log.warn?.(`[jev-price] HTTP ${res.status}`); return null; }
      const a = (await res.json())?.answers ?? {};
      const p = candidates.map((_, i) => a[`c${i}`]?.noul);
      return p.every((v) => typeof v === 'number') ? p : null;
    } catch (err) {
      log.warn?.(`[jev-price] ${err.name}: ${err.message}`);
      return null;
    }
  }

  // The comparison for one endpoint: { price_usd, comparable_median_usd, comparables, ratio, cheaper[] }, or null
  // when off, there is no price or description, or too few comparable services were found.
  async function compare(url, { description, priceUsd }) {
    if (!enabled || !(priceUsd > 0) || !description) return null;
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
    const text = String(description).trim().slice(0, 600);
    const key = JSON.stringify([host, text]);
    let hit = cache.get(key);
    if (!hit || hit.at <= Date.now() - ttlMs) {
      const candidates = await trustIndex.similar(url, text, { waitMs: 3000 }).catch(() => []);
      if (candidates.length < MIN_COMPARABLE) return null;
      const p = await sameKind(host, text, candidates);
      if (!p) return null;
      hit = { at: Date.now(), same: candidates.filter((_, i) => p[i] >= SAME) };
      if (cache.size >= max) cache.delete(cache.keys().next().value);
      cache.set(key, hit);
    }
    if (hit.same.length < MIN_COMPARABLE) return null;
    const mid = median(hit.same.map((c) => c.price_usd));
    return {
      price_usd: priceUsd,
      comparable_median_usd: round(mid),
      comparables: hit.same.length,
      ratio: Math.round((priceUsd / mid) * 10) / 10,
      cheaper: hit.same
        .filter((c) => c.price_usd < priceUsd)
        .sort((a, b) => a.price_usd - b.price_usd)
        .slice(0, 3)
        .map((c) => ({ url: c.url, price_usd: c.price_usd, description: c.description.slice(0, 120) })),
    };
  }

  return { enabled, compare };
}

// The preflight reason for a comparison, or null when the price is in line.
function priceReason(cmp) {
  if (!cmp) return null;
  const gap = cmp.price_usd - cmp.comparable_median_usd;
  const level = cmp.ratio >= CAUTION_RATIO && gap >= CAUTION_GAP ? 'caution' : cmp.ratio >= INFO_RATIO && gap >= INFO_GAP ? 'info' : null;
  if (!level) return null;
  const alt = cmp.cheaper.length ? ` Cheaper alternatives: ${cmp.cheaper.map((c) => `${c.url} ($${c.price_usd})`).join(', ')}.` : '';
  return {
    level,
    code: 'price_high',
    message: `Costs $${cmp.price_usd}, ${cmp.ratio}x the median of $${cmp.comparable_median_usd} across ${cmp.comparables} comparable paid APIs in the x402 Trust Index (comparable as judged by TypeSafe Jev).${alt}`,
  };
}

module.exports = { createPriceCheck, priceReason, median };
