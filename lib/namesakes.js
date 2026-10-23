// Namesakes: one service name, several sellers. The x402 Bazaar indexes each listing's serviceName, so an agent that
// searches for "x402 Doctor" or "Otto AI" finds every listing with that name. When another seller, with its own
// payout address, lists under the name of an established service (doctor.promoclube.online as "X402 Doctor" since
// 19 Oct 2026, or a reseller that proxies a brand under the brand's name), a buyer can pay someone else than the
// service it means.
//
// Code: listings grouped by service name (trimmed, lower case, spaces collapsed); within a name, sites that share a
// payout address are one owner (stablestudio.dev and stablestudio.io, ax1.vc and its Vercel preview). A name with two
// or more owners is a case: the owner with the most unique payers in the last 30 days (then the most calls) is the
// original, the others are its namesakes. TypeSafe's Jev answers whether the name is a brand (a service's own name,
// such as "x402 Doctor" or "StableEnrich") rather than a description of what it does ("web search", "weather
// forecast"): only brands count. The result goes into the Trust Index (scripts/namesakes.js), and the preflight adds
// an info line on a namesake's endpoints (lib/preflight.js). It never changes a verdict: a namesake can be a fair
// reseller or an unrelated service, and the buyer decides.
'use strict';

const { siteOf } = require('./site');
const { keyOf } = require('./bazaar-index');

const API = 'https://api.typesafe.ai/v1/systemone';
const BRAND_SURE = 0.85;
const BATCH = 25;

const nameOf = (s) => {
  const n = String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n.length >= 3 && n.length <= 60 ? n : null;
};
const lc = (a) => String(a ?? '').toLowerCase();

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
    byName.get(name).listings.push({ site: siteOf(host), key, url: it.resource, payTos, payers: q.l30DaysUniquePayers || 0, calls: q.l30DaysTotalCalls || 0, description: String(it.description || '').slice(0, 200) });
  }
  const cases = [];
  for (const [name, { label, listings }] of byName) {
    if (new Set(listings.map((l) => l.site)).size < 2) continue;
    // Owners: sites joined by a shared payout address (union-find over sites).
    const parent = new Map();
    const find = (s) => { while (parent.get(s) !== s) s = parent.get(s); return s; };
    for (const l of listings) if (!parent.has(l.site)) parent.set(l.site, l.site);
    const firstSiteOf = new Map();
    for (const l of listings) for (const p of l.payTos) {
      if (!firstSiteOf.has(p)) firstSiteOf.set(p, l.site);
      else parent.set(find(l.site), find(firstSiteOf.get(p)));
    }
    const owners = new Map();
    for (const l of listings) {
      const root = find(l.site);
      if (!owners.has(root)) owners.set(root, { sites: new Set(), payTos: new Set(), keys: [], payers: 0, calls: 0, url: l.url, description: l.description });
      const o = owners.get(root);
      o.sites.add(l.site);
      l.payTos.forEach((p) => o.payTos.add(p));
      o.keys.push(l.key);
      o.payers = Math.max(o.payers, l.payers);
      o.calls += l.calls;
      if (l.payers > (o.best ?? -1)) { o.best = l.payers; o.url = l.url; o.description = l.description; }
    }
    if (owners.size < 2) continue;
    const ranked = [...owners.values()].map(({ best, ...o }) => ({ ...o, sites: [...o.sites].sort(), payTos: [...o.payTos] }))
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

// The namesake record per resource key, for the cases whose name is a brand: { key: ns }.
function namesakeEntries(cases, brand, { sure = BRAND_SURE } = {}) {
  const out = {};
  for (const c of cases) {
    if (!((brand?.[c.name] ?? 0) >= sure)) continue;
    for (const n of c.namesakes) {
      const ns = { name: c.label, original: { site: c.original.sites[0], url: c.original.url, payers: c.original.payers }, payers: n.payers };
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

module.exports = { casesOf, createBrandCheck, namesakeEntries, namesakeReason, nameOf, BRAND_SURE };
