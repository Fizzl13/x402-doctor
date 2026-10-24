// Namesakes: one service name, several sellers. The x402 Bazaar indexes each listing's serviceName, so an agent that
// searches for "x402 Doctor" or "Otto AI" finds every listing with that name. When another seller, with its own
// payout address, lists under the name of an established service (doctor.promoclube.online as "X402 Doctor" since
// 19 Oct 2026, or a reseller that proxies a brand under the brand's name), a buyer can pay someone else than the
// service it means.
//
// Code: listings grouped by service name (trimmed, lower case, spaces collapsed). Within a name these count as one
// owner: sites that share a payout address (stablestudio.dev and stablestudio.io, ax1.vc and its Vercel preview),
// sites whose host names share a distinctive word (x402check.xyz and x402check.arden-instance.workers.dev, a
// production and a staging host), and two sites that list three or more of the same names (one operator on two
// domains, or a mirror: on 23 Oct 2026 lonestaroracle.xyz and theaslangroupllc.com shared four, x402tap.com and
// agentx402pay.com twelve). A name with two or more owners is a case: the owner with the most unique payers in the last 30 days (then the most calls) is the
// original, the others are its namesakes. TypeSafe's Jev answers whether the name is a brand (a service's own name,
// such as "x402 Doctor" or "StableEnrich") rather than a description of what it does ("web search", "weather
// forecast"): only brands count. A name that is the original's own site name counts as a brand whatever Jev says
// ("X402 Doctor" for x402-doctor.fizzl.eu, "x402-gateway" for x402-gateway.ai): on 24 Oct 2026 Jev read "x402 doctor"
// as a description (0.17), and the case this was built for went unmarked. The result goes into the Trust Index (scripts/namesakes.js), and the preflight adds
// an info line on a namesake's endpoints (lib/preflight.js). It never changes a verdict: a namesake can be a fair
// reseller or an unrelated service, and the buyer decides.
'use strict';

const { siteOf } = require('./site');
const { keyOf } = require('./bazaar-index');

const API = 'https://api.typesafe.ai/v1/systemone';
const BRAND_SURE = 0.85;
const BATCH = 25;

// Host-name words that say nothing about who runs a site.
const COMMON = new Set(['x402', 'agent', 'agents', 'api', 'apis', 'app', 'apps', 'data', 'tool', 'tools', 'workers', 'vercel', 'netlify', 'onrender', 'render', 'railway', 'deno', 'pages', 'herokuapp', 'replit', 'github', 'staging', 'production', 'prod', 'test', 'demo', 'service', 'services', 'online', 'cloud', 'server', 'labs', 'network', 'instance', 'space', 'store', 'shop', 'world', 'gateway', 'oracle', 'market', 'markets', 'finance', 'crypto', 'pay', 'payments']);
const wordsOfSite = (site) => new Set(String(site).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !COMMON.has(w) && !/^\d+$/.test(w)));
const sharesWord = (a, b) => { for (const w of a) if (b.has(w)) return true; return false; };
const RELATED_NAMES = 3;

const nameOf = (s) => {
  const n = String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n.length >= 3 && n.length <= 60 ? n : null;
};
const lc = (a) => String(a ?? '').toLowerCase();
const compact = (s) => lc(s).replace(/[^a-z0-9]/g, '');
const OWN_NAME_MIN = 6; // shorter names ("api", "data") match too many host names

// Is the case's name the original's own site name, punctuation and spaces aside? The site's own label counts
// (x402-gateway.ai, or the first label on a shared host such as tablegrab.onrender.com). A subdomain counts only for a
// name with a digit or a single word ("x402 Doctor" for x402-doctor.fizzl.eu), since sellers also name subdomains after
// what a tool does (asn-lookup.underscoredone.com lists "ASN Lookup", a description).
function ownSiteName(c) {
  const name = compact(c?.name);
  if (name.length < OWN_NAME_MIN) return false;
  const coined = /\d/.test(c.name) || !/\s/.test(String(c.name).trim());
  return (c.original?.hosts || []).some((h) => {
    const host = String(h), site = siteOf(host);
    const own = site === host ? host.split('.')[0] : site.split('.')[0];
    if (compact(own) === name) return true;
    return coined && host.split('.').slice(0, -1).some((label) => compact(label) === name);
  });
}
// A case counts when Jev is sure the name is a brand, or the name is the original's own site name.
const isBrand = (c, brand, sure = BRAND_SURE) => (brand?.[c.name] ?? 0) >= sure || ownSiteName(c);

// The cases in a list of Bazaar items: [{ name, label, original, namesakes }], biggest originals first. original and
// each namesake: { sites, payTos, keys, payers, calls, url, description }.
function casesOf(items) {
  const byName = new Map();
  for (const it of items || []) {
    const name = nameOf(it?.serviceName);
    if (!name) continue;
    let host, key;
    try { host = new URL(it.resource).hostname; key = keyOf(it.resource); } catch { continue; }
    const payTos = [...new Set((it.accepts || []).map((a) => lc(a?.payTo)).filter(Boolean))];
    const q = it.quality || {};
    if (!byName.has(name)) byName.set(name, { label: String(it.serviceName).trim(), listings: [] });
    byName.get(name).listings.push({ site: siteOf(host), host: lc(host), key, url: it.resource, payTos, payers: q.l30DaysUniquePayers || 0, calls: q.l30DaysTotalCalls || 0, description: String(it.description || '').slice(0, 200) });
  }
  // Sites that list RELATED_NAMES or more of the same names: one operator (or a mirror).
  const pairCount = new Map();
  for (const { listings } of byName.values()) {
    const sites = [...new Set(listings.map((l) => l.site))].sort();
    for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
      const k = `${sites[i]} ${sites[j]}`;
      pairCount.set(k, (pairCount.get(k) || 0) + 1);
    }
  }
  const related = (a, b) => (pairCount.get(a < b ? `${a} ${b}` : `${b} ${a}`) || 0) >= RELATED_NAMES;
  const cases = [];
  for (const [name, { label, listings }] of byName) {
    if (new Set(listings.map((l) => l.site)).size < 2) continue;
    // Owners (union-find over sites): a shared payout address, a shared host-name word, or related sites.
    const parent = new Map();
    const find = (s) => { while (parent.get(s) !== s) s = parent.get(s); return s; };
    const join = (a, b) => parent.set(find(a), find(b));
    for (const l of listings) if (!parent.has(l.site)) parent.set(l.site, l.site);
    const firstSiteOf = new Map();
    for (const l of listings) for (const p of l.payTos) {
      if (!firstSiteOf.has(p)) firstSiteOf.set(p, l.site);
      else join(l.site, firstSiteOf.get(p));
    }
    const sites = [...parent.keys()];
    for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
      if (sharesWord(wordsOfSite(sites[i]), wordsOfSite(sites[j])) || related(sites[i], sites[j])) join(sites[i], sites[j]);
    }
    const owners = new Map();
    for (const l of listings) {
      const root = find(l.site);
      if (!owners.has(root)) owners.set(root, { sites: new Set(), hosts: new Set(), payTos: new Set(), keys: [], payers: 0, calls: 0, url: l.url, description: l.description });
      const o = owners.get(root);
      o.sites.add(l.site);
      o.hosts.add(l.host);
      l.payTos.forEach((p) => o.payTos.add(p));
      o.keys.push(l.key);
      o.payers = Math.max(o.payers, l.payers);
      o.calls += l.calls;
      if (l.payers > (o.best ?? -1)) { o.best = l.payers; o.url = l.url; o.description = l.description; }
    }
    if (owners.size < 2) continue;
    const ranked = [...owners.values()].map(({ best, ...o }) => ({ ...o, sites: [...o.sites].sort(), hosts: [...o.hosts].sort(), payTos: [...o.payTos] }))
      .sort((a, b) => b.payers - a.payers || b.calls - a.calls);
    // A tie at the top has no original: two services that happen to share a name, neither better known.
    if (ranked[0].payers === ranked[1].payers && ranked[0].calls === ranked[1].calls) continue;
    cases.push({ name, label, original: ranked[0], namesakes: ranked.slice(1) });
  }
  return cases.sort((a, b) => b.original.payers - a.original.payers);
}

// Jev: is each name a brand? { name: probability } for the names it answered; {} when off or failing.
function createBrandCheck({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20000, model = process.env.JEV_MODEL || 'jev-latest', log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== 'off';
  async function brands(cases) {
    const out = {};
    if (!enabled) return out;
    for (let i = 0; i < cases.length; i += BATCH) {
      const batch = cases.slice(i, i + BATCH);
      const state = { names: batch.map((c) => ({ name: c.label, description: c.original.description })) };
      const questions = Object.fromEntries(batch.map((_, j) => [`n${j}`, {
        type: 'noul',
        instructions: `Is \`names[${j}].name\` the own name of one particular service, product or company (for example "x402 Doctor", "Otto AI", "StableEnrich", "AX1 Console"), rather than a plain description of what the service does (for example "web search", "weather forecast", "uuid generator", "crypto news")? \`names[${j}].description\` says what it does.`,
        criteria: { true: 'A brand or product name of one service', false: 'A generic description of a kind of service' },
      }]));
      try {
        const res = await fetchImpl(API, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, state, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) { log.warn?.(`[namesakes] HTTP ${res.status}`); continue; }
        const answers = (await res.json())?.answers ?? {};
        batch.forEach((c, j) => { const p = answers[`n${j}`]?.noul; if (typeof p === 'number') out[c.name] = Math.round(p * 100) / 100; });
      } catch (err) {
        log.warn?.(`[namesakes] ${err.name}: ${err.message}`);
      }
    }
    return out;
  }
  return { enabled, brands };
}

// The namesakes that count: fewer payers than the original (with as many, neither is the better-known one).
const lesserOf = (c) => c.namesakes.filter((n) => n.payers < c.original.payers);

// The namesake record per resource key, for the cases whose name is a brand: { key: ns }. The original's site is the
// host of its best-known listing (x402-doctor.fizzl.eu rather than fizzl.eu), so a buyer can tell where to go.
function namesakeEntries(cases, brand, { sure = BRAND_SURE } = {}) {
  const out = {};
  for (const c of cases) {
    if (!isBrand(c, brand, sure)) continue;
    let site = c.original.sites[0];
    try { site = new URL(c.original.url).hostname; } catch { /* keep the site */ }
    for (const n of lesserOf(c)) {
      const ns = { name: c.label, original: { site, url: c.original.url, payers: c.original.payers }, payers: n.payers };
      for (const key of n.keys) out[key] = ns;
    }
  }
  return out;
}

// The preflight's info line for a namesake (the lookup's namesake field), or null.
function namesakeReason(ns) {
  if (!ns?.name || !ns.original?.site) return null;
  return {
    level: 'info',
    code: 'namesake',
    message: `Another seller lists a service under the same name: "${ns.name}" is also at ${ns.original.site} (${ns.original.payers} payers in the last 30 days, this one ${ns.payers}), with a different payout address. Check that this is the service you mean before paying.`,
  };
}

module.exports = { casesOf, createBrandCheck, namesakeEntries, namesakeReason, lesserOf, nameOf, ownSiteName, isBrand, BRAND_SURE };
