// How many different services are behind the endpoints in the Trust Index, and what kind they are. One seller
// can list hundreds of near-identical endpoints (the same API for every coin, city or ticker): counting those as
// hundreds of services overstates the market. Per seller, endpoints whose descriptions share most of their words
// (Jaccard >= 0.5) count as one service. Each service gets a category: TypeSafe Jev's choice when it is in the
// published cache (categories.json on the trust-data branch, written by scripts/categorize.js), otherwise a
// keyword guess, so the pages work before and without Jev.
'use strict';

const crypto = require('crypto');
const { siteOf } = require('./site');

const CATEGORIES = [
  { id: 'crypto', name: 'Crypto prices & trading', words: ['crypto', 'bitcoin', 'btc', 'eth', 'ethereum', 'solana', 'token', 'tokens', 'price', 'prices', 'trading', 'trade', 'signal', 'signals', 'market', 'markets', 'dex', 'swap', 'defi', 'ohlc', 'candles', 'ichimoku', 'coin', 'coins', 'memecoin', 'yield', 'funding'] },
  { id: 'security', name: 'Security & risk checks', words: ['security', 'safety', 'safe', 'scam', 'rug', 'honeypot', 'drainer', 'phishing', 'risk', 'audit', 'sanction', 'sanctions', 'approval', 'approvals', 'verify', 'verdict', 'fraud', 'malicious', 'screening'] },
  { id: 'onchain', name: 'Wallets & on-chain data', words: ['wallet', 'wallets', 'address', 'onchain', 'blockchain', 'transaction', 'transactions', 'balance', 'balances', 'nft', 'nfts', 'contract', 'contracts', 'holders', 'explorer', 'gas'] },
  { id: 'ai', name: 'AI models & text generation', words: ['llm', 'gpt', 'claude', 'model', 'models', 'inference', 'prompt', 'chat', 'completion', 'completions', 'embedding', 'embeddings', 'summarize', 'summary', 'classify', 'sentiment'] },
  { id: 'search', name: 'Search, web & news', words: ['search', 'web', 'scrape', 'scraping', 'crawl', 'crawler', 'browse', 'browser', 'page', 'pages', 'url', 'urls', 'news', 'serp', 'google', 'extract'] },
  { id: 'finance', name: 'Stocks, macro & finance', words: ['stock', 'stocks', 'equity', 'equities', 'forex', 'finance', 'financial', 'earnings', 'nasdaq', 'nyse', 'commodity', 'commodities', 'gold', 'interest', 'economic', 'macro', 'fred'] },
  { id: 'media', name: 'Images, audio & video', words: ['image', 'images', 'photo', 'picture', 'video', 'videos', 'audio', 'voice', 'speech', 'tts', 'music', 'transcribe', 'transcription', 'art', 'ocr', 'pdf'] },
  { id: 'places', name: 'Weather, maps & places', words: ['weather', 'forecast', 'temperature', 'climate', 'rain', 'geo', 'geocode', 'location', 'map', 'maps', 'places', 'city', 'country', 'timezone'] },
  { id: 'social', name: 'Social & people', words: ['twitter', 'tweet', 'tweets', 'social', 'reddit', 'farcaster', 'telegram', 'discord', 'profile', 'profiles', 'followers', 'email', 'people', 'linkedin'] },
  { id: 'dev', name: 'Developer tools', words: ['code', 'github', 'deploy', 'test', 'testing', 'monitor', 'monitoring', 'uptime', 'dns', 'ssl', 'convert', 'validate', 'debug', 'diagnose', 'webhook', 'hosting', 'publish'] },
  { id: 'data', name: 'Other data & lookups', words: [] },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

const STOP = new Set('the and for with from that this your you are api apis via per call calls get returns return data paid pay payment payments x402 usdc agent agents service services endpoint endpoints any all one into using use when can its not but will has have was json response request requests based more than also only each'.split(' '));
function wordsOf(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !STOP.has(w)));
}

// The keyword guess: the category whose words the description uses most, "data" when none.
function guessCategory(text) {
  const have = wordsOf(text);
  let best = 'data';
  let top = 0;
  for (const c of CATEGORIES) {
    const n = c.words.filter((w) => have.has(w)).length;
    if (n > top) { top = n; best = c.id; }
  }
  return best;
}

// The cache key of a description: Jev's answers are kept per text, so an unchanged service is never asked again.
const descKey = (text) => crypto.createHash('sha1').update(String(text || '').trim().toLowerCase()).digest('hex').slice(0, 16);

const jaccard = (a, b) => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const all = a.size + b.size - shared;
  return all ? shared / all : 1;
};

// Groups the payable resources of the index into services. Returns { services: [{ site, rep, members }], byUrl,
// bySite } where rep is the first resource of the group (its description stands for the service), byUrl maps a
// resource URL to its service and bySite counts endpoints and services per seller.
function groupServices(resources, { threshold = 0.5 } = {}) {
  const perSite = new Map();
  for (const entry of Object.values(resources || {})) {
    if (!entry?.last || !['go', 'caution'].includes(entry.last.verdict)) continue;
    let host;
    try { host = new URL(entry.url).hostname; } catch { continue; }
    const site = siteOf(host);
    if (!perSite.has(site)) perSite.set(site, []);
    perSite.get(site).push(entry);
  }
  const services = [];
  const byUrl = new Map();
  const bySite = {};
  for (const [site, entries] of perSite) {
    const groups = [];
    for (const entry of entries) {
      const words = wordsOf(entry.d || new URL(entry.url).pathname.replace(/[/_-]+/g, ' '));
      let group = null;
      for (const g of groups) if (jaccard(g.words, words) >= threshold) { group = g; break; }
      if (!group) {
        group = { site, rep: entry, words, members: [] };
        groups.push(group);
        services.push(group);
      }
      group.members.push(entry.url);
      byUrl.set(entry.url, group);
    }
    bySite[site] = { endpoints: entries.length, services: groups.length };
  }
  return { services, byUrl, bySite };
}

// The category of a service: Jev's cached answer for its description, else the keyword guess.
function categoryOf(service, cache) {
  const text = service.rep.d || service.rep.url;
  const jev = cache?.[descKey(text)];
  return CATEGORY_IDS.includes(jev) ? jev : guessCategory(text);
}

module.exports = { CATEGORIES, CATEGORY_IDS, guessCategory, descKey, groupServices, categoryOf, wordsOf };
