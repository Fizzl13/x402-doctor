// "Who saw a price, who paid" for the owner's usage page (/admin/usage): every caller that got a 402 (the price) in
// the range, grouped per visitor, sorted into checkers (indexers, directories, monitors, testers: they read every
// price and never buy), browsers (a person opening a paid URL) and clients (code that could be a buying agent), and
// how many of each paid afterwards. Frits asked on 3 Nov 2026 why so few payments come in; this shows where callers
// drop off. Counted from a small per-file summary (one row per visitor), so it covers the whole range, not only the
// newest 20,000 calls. Visitors are the log's visitor codes (a keyed hash of the IP): an agent that sees the price
// from one machine and pays from another counts twice.
'use strict';

const { OWN_AGENTS } = require('./usage-payments');

// The log already writes a browser's user agent as "browser".
const BROWSER = /^browser$|mozilla|chrome|safari|firefox|edg\//i;
const MAX_VISITORS_PER_FILE = 5000; // a flood of new visitors in one file is cut, not kept in memory

// One log file, cut down to what the funnel needs: per visitor [quotes, payments, agent number], and per agent the
// services and routes it was quoted (per agent, not per visitor, to keep the summary small: Doctor runs in 512 MB).
function visitorsOf(events) {
  const agents = [];
  const agentIx = new Map();
  const v = {};
  const services = {};
  const routes = {};
  let kept = 0;
  for (const e of events || []) {
    if (!e || !e.visitor) continue;
    const isQuote = e.quote === true;
    const isPaid = e.paid === true && !e.quote;
    if (!isQuote && !isPaid) continue;
    const agent = e.agent ? String(e.agent).slice(0, 80) : '';
    if (!agentIx.has(agent)) { agentIx.set(agent, agents.length); agents.push(agent); }
    const ai = agentIx.get(agent);
    let row = v[e.visitor];
    if (!row) {
      if (kept >= MAX_VISITORS_PER_FILE) continue;
      row = v[e.visitor] = [0, 0, ai];
      kept += 1;
    }
    if (isQuote) {
      const n = Number(e.count) || 1;
      row[0] += n;
      const s = (services[ai] = services[ai] || {});
      if (e.service) s[e.service] = (s[e.service] || 0) + n;
      const r = (routes[ai] = routes[ai] || {});
      const route = `${e.service || '?'} ${e.route || '?'}`;
      r[route] = (r[route] || 0) + n;
    } else {
      row[1] += 1;
    }
  }
  return { agents, v, services, routes };
}

// known.json (scripts/known.json of the usage log): monitor_agents and test_agents as regex strings.
function regexOf(s) {
  try { return s ? new RegExp(s, 'i') : null; } catch { return null; }
}
function parseKnownAgents(text) {
  let k = {};
  try { k = JSON.parse(text || '{}') || {}; } catch { k = {}; }
  return { monitors: regexOf(k.monitor_agents), tests: regexOf(k.test_agents) };
}

// "own" (left out), "checker", "browser" or "client".
function kindOf(agent, known) {
  const a = String(agent || '');
  if (OWN_AGENTS.test(a)) return 'own';
  if ((known.monitors && known.monitors.test(a)) || (known.tests && known.tests.test(a))) return 'checker';
  if (BROWSER.test(a)) return 'browser';
  return 'client';
}

const KINDS = ['client', 'browser', 'checker'];
const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

// files: summarizeAll(visitorsOf) results; fromIso: start of the range (files are per day, so the day is compared).
function summarizeFunnel(files, { known, fromIso } = {}) {
  const k = known || parseKnownAgents('{}');
  const fromDay = String(fromIso || '').slice(0, 10);
  const visitors = new Map(); // id -> { q, p, a }
  const agentServices = {};
  const agentRoutes = {};
  const add = (into, key, obj) => {
    const t = (into[key] = into[key] || {});
    for (const [x, n] of Object.entries(obj || {})) t[x] = (t[x] || 0) + n;
  };
  for (const f of files || []) {
    const sum = f.summary;
    if (!sum || (fromDay && f.date < fromDay)) continue;
    const names = sum.agents || [];
    for (const [id, [q, p, ai]] of Object.entries(sum.v || {})) {
      const v = visitors.get(id) || { q: 0, p: 0, a: null };
      v.q += q;
      v.p += p;
      if (!v.a && names[ai]) v.a = names[ai];
      visitors.set(id, v);
    }
    for (const [ai, obj] of Object.entries(sum.services || {})) add(agentServices, names[ai] || '', obj);
    for (const [ai, obj] of Object.entries(sum.routes || {})) add(agentRoutes, names[ai] || '', obj);
  }

  const kinds = Object.fromEntries(KINDS.map((x) => [x, { visitors: 0, quotes: 0, paid_visitors: 0 }]));
  const lookersBy = new Map(); // callers that saw a price and never paid, per agent
  let ownLeftOut = 0;
  for (const v of visitors.values()) {
    if (!v.q) continue; // paid without a 402 in the range: not part of the funnel
    const kind = kindOf(v.a, k);
    if (kind === 'own') { ownLeftOut += 1; continue; }
    const t = kinds[kind];
    t.visitors += 1;
    t.quotes += v.q;
    if (v.p > 0) { t.paid_visitors += 1; continue; }
    const key = v.a || '';
    const g = lookersBy.get(key) || { agent: key || '(no user agent)', kind, visitors: 0, quotes: 0 };
    g.visitors += 1;
    g.quotes += v.q;
    lookersBy.set(key, g);
  }
  for (const t of Object.values(kinds)) t.paid_pct = t.visitors ? Math.round((t.paid_visitors / t.visitors) * 1000) / 10 : 0;

  const clientRoutes = {};
  for (const [agent, obj] of Object.entries(agentRoutes)) {
    if (kindOf(agent, k) !== 'client') continue;
    for (const [r, n] of Object.entries(obj)) clientRoutes[r] = (clientRoutes[r] || 0) + n;
  }
  const lookers = [...lookersBy.entries()]
    .sort((a, b) => b[1].quotes - a[1].quotes)
    .slice(0, 25)
    .map(([key, g]) => ({ ...g, services: top(agentServices[key] || {}, 3).map(([s]) => s) }));
  return {
    from: fromIso,
    kinds,
    own_left_out: ownLeftOut,
    lookers, // most quotes first
    client_routes: top(clientRoutes, 10).map(([route, quotes]) => ({ route, quotes })),
  };
}

module.exports = { visitorsOf, parseKnownAgents, kindOf, summarizeFunnel };
