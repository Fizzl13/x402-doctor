// Payments for the owner's usage page (/admin/usage): every paid call in the range, sorted into outside customers,
// our own wallets and test payers, so the page can say at a glance whether anyone else paid. Counted from a small
// per-file summary (only the paid events), so it covers the whole range even when the page's event list is cut at
// the newest 20,000 calls (about one day of traffic since late Oct 2026).
'use strict';

// Our own workflows pay with these user agents (the spot-buy sample, the index payment, the delivery and buy checks,
// and Claude's smoke tests as fizzl-monitor/…).
const OWN_AGENTS = /x402-doctor-(spot-buy|index-payment|delivery-check|buy-check)|^fizzl-monitor\//i;
const DAY = 86400000;

// The paid events of one log file, cut down to what the page shows.
function paidOf(events) {
  const out = [];
  for (const e of events || []) {
    if (!e || e.paid !== true || e.quote) continue;
    out.push({
      t: e.t, service: e.service, route: e.route, usd: Number(e.usd) || 0, network: e.network || null,
      payer: e.payer || null, agent: e.agent || null, visitor: e.visitor || null,
      ...(e.protocol ? { protocol: e.protocol } : {}), ...(e.via ? { via: e.via } : {}),
    });
  }
  return out;
}

// scripts/known.json of the usage log: own_wallets, test_payers, test_agents (one regex string).
function parseKnown(text) {
  let k = {};
  try { k = JSON.parse(text || '{}') || {}; } catch { k = {}; }
  let testAgents = null;
  try { testAgents = k.test_agents ? new RegExp(k.test_agents, 'i') : null; } catch { testAgents = null; }
  return {
    own: new Set((Array.isArray(k.own_wallets) ? k.own_wallets : []).map((a) => String(a).toLowerCase())),
    test: new Map(Object.entries(k.test_payers && typeof k.test_payers === 'object' ? k.test_payers : {}).map(([a, why]) => [a.toLowerCase(), String(why)])),
    testAgents,
  };
}

// "own", "test" or "outside", with why for the first two.
function classify(p, known) {
  const payer = String(p.payer || '').toLowerCase();
  if (OWN_AGENTS.test(String(p.agent || '')) || (payer && known.own.has(payer))) return { kind: 'own', why: 'our own wallet or workflow' };
  if (payer && known.test.has(payer)) return { kind: 'test', why: known.test.get(payer) };
  if (known.testAgents && known.testAgents.test(String(p.agent || ''))) return { kind: 'test', why: 'test agent' };
  return { kind: 'outside', why: null };
}

const sum = (list) => Math.round(list.reduce((s, p) => s + p.usd, 0) * 1e6) / 1e6;

// files: summarizeAll(paidOf) results; fromIso: start of the range; now: ms.
function summarizePayments(files, { known, fromIso, now = Date.now() } = {}) {
  const k = known || parseKnown('{}');
  const all = [];
  for (const f of files || []) for (const p of f.summary || []) if (p.t >= fromIso) all.push({ ...p, ...classify(p, k) });
  all.sort((a, b) => (a.t < b.t ? 1 : -1));

  const today = new Date(now).toISOString().slice(0, 10);
  const since = (ms) => new Date(now - ms).toISOString();
  const windows = { today: (p) => p.t.slice(0, 10) === today, d7: (p) => p.t >= since(7 * DAY), range: () => true };
  const totals = {};
  for (const [w, inWindow] of Object.entries(windows)) {
    const list = all.filter(inWindow);
    totals[w] = {};
    for (const kind of ['outside', 'own', 'test']) {
      const of = list.filter((p) => p.kind === kind);
      totals[w][kind] = { payments: of.length, usd: sum(of), payers: new Set(of.map((p) => p.payer || p.visitor).filter(Boolean)).size };
    }
  }

  // Outside customers: one row per payer (or visitor, for an MPP payment without one).
  const byPayer = new Map();
  for (const p of all.filter((x) => x.kind === 'outside')) {
    const id = p.payer || `visitor ${p.visitor || '?'}`;
    const c = byPayer.get(id) || { payer: id, payments: 0, usd: 0, first: p.t, last: p.t, services: new Set(), networks: new Set(), agents: new Set() };
    c.payments += 1;
    c.usd += p.usd;
    if (p.t < c.first) c.first = p.t;
    if (p.t > c.last) c.last = p.t;
    c.services.add(p.service);
    if (p.network) c.networks.add(p.network);
    if (p.agent) c.agents.add(p.agent);
    byPayer.set(id, c);
  }
  const customers = [...byPayer.values()]
    .map((c) => ({ ...c, usd: Math.round(c.usd * 1e6) / 1e6, services: [...c.services], networks: [...c.networks], agents: [...c.agents].slice(0, 3) }))
    .sort((a, b) => (a.last < b.last ? 1 : -1));

  return { from: fromIso, today, totals, customers, recent: all.slice(0, 40) };
}

module.exports = { paidOf, parseKnown, classify, summarizePayments, OWN_AGENTS };
