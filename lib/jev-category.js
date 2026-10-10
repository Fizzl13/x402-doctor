// What kind of service is it? TypeSafe's Jev picks one category per service description (a Choice question),
// for the Trust Index pages and the per-network digests. Used by scripts/categorize.js, which keeps every answer
// in categories.json on the trust-data branch, so a description is asked about once. Off without
// TYPESAFE_API_KEY; a failed batch leaves its descriptions unanswered (the keyword guess stands in for them).
'use strict';

const { CATEGORIES } = require('./services');

const API = 'https://api.typesafe.ai/v1/systemone';

const CRITERIA = Object.fromEntries(CATEGORIES.map((c) => [c.id, {
  crypto: 'Crypto prices, market data, trading signals, DEX or DeFi data',
  security: 'Security, fraud or risk checks: scams, drainers, sanctions, audits, verifying something before trusting or paying',
  onchain: 'Wallet, address, transaction, NFT or smart-contract data read from a blockchain',
  ai: 'Runs an AI model: chat or text generation, embeddings, classification, summaries',
  search: 'Web search, scraping, crawling, news or reading web pages',
  finance: 'Stocks, forex, commodities, macro-economic or company financial data',
  media: 'Makes or processes images, audio, video or documents (OCR, PDF, speech)',
  places: 'Weather, maps, geocoding, places or time zones',
  social: 'Social networks, people, profiles, email or messaging',
  dev: 'Tools for developers: hosting, deploying, testing, monitoring, converting or validating',
  data: 'Any other data lookup or utility that fits none of the above',
}[c.id]]));

function createCategorizer({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, batch = 25, timeoutMs = 15000, model = process.env.JEV_MODEL || 'jev-latest', log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== 'off';

  // items: [{ key, host, description }]. Returns { [key]: categoryId } for the ones Jev answered.
  async function categorize(items) {
    const out = {};
    if (!enabled) return out;
    for (let i = 0; i < items.length; i += batch) {
      const part = items.slice(i, i + batch);
      const questions = {};
      part.forEach((it, j) => {
        questions[`s${j}`] = {
          type: 'choice',
          instructions: { service: { host: it.host, description: String(it.description || '').slice(0, 400) }, question: 'What kind of paid API is `service`? Pick the category that best describes what a buyer gets from it.' },
          criteria: CRITERIA,
        };
      });
      try {
        const res = await fetchImpl(API, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, state: {}, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) { log.warn?.(`[jev-category] HTTP ${res.status}`); continue; }
        const answers = (await res.json())?.answers ?? {};
        part.forEach((it, j) => {
          const c = answers[`s${j}`]?.choice;
          if (typeof c === 'string' && CRITERIA[c]) out[it.key] = c;
        });
      } catch (err) {
        log.warn?.(`[jev-category] ${err.name}: ${err.message}`);
      }
    }
    return out;
  }

  return { enabled, categorize };
}

module.exports = { createCategorizer, CRITERIA };
