// The Solana facilitator (lib/facilitator-service.js) on the owner's usage page (/admin/usage): how many settles went
// through, for which sellers, paid how (free or credits), what was refused and why, and how much USDC moved from
// buyers to sellers through it. Counted from a small per-file summary of the usage log (server.js logs every
// /facilitator call as "facilitator <step>"), so it covers the whole range like the payments at the top of the page.
// Sellers whose payTo is one of our own wallets (own_wallets in scripts/known.json) are marked as ours.
'use strict';

const MAX_ROWS_PER_FILE = 2000; // a flood in one hour file is cut, not kept in memory
const STEP = /^facilitator (\S+)$/;

// One log file: call counts per step (info, supported, verify, settle, health) and one row per verify/settle.
function facilitatorOf(events, { service } = {}) {
  const calls = {};
  const rows = [];
  if (service && service !== 'doctor') return { calls, rows };
  for (const e of events || []) {
    const m = e && typeof e.route === 'string' ? STEP.exec(e.route) : null;
    if (!m) continue;
    const step = m[1];
    calls[step] = (calls[step] || 0) + (Number(e.count) || 1);
    if ((step !== 'settle' && step !== 'verify') || rows.length >= MAX_ROWS_PER_FILE) continue;
    const input = e.input || {};
    const result = e.result || {};
    rows.push({
      t: e.t,
      step,
      via: e.via || null,
      status: e.status,
      ok: result.ok === true,
      reason: result.reason || (e.status === 402 ? 'facilitator_payment_required' : null),
      pay_to: input.pay_to || null,
      payer: result.payer || null,
      amount: input.amount != null ? String(input.amount) : null,
      tx: result.tx || null,
      agent: e.agent || null,
    });
  }
  return { calls, rows };
}

const usdOf = (amount) => {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0 ? n / 1e6 : 0; // USDC has 6 decimals
};
const round = (x) => Math.round(x * 1e6) / 1e6;

// files: summarizeAll(facilitatorOf) results. known: parseKnown() from usage-payments (own wallets).
function summarizeFacilitator(files, { known = null, fromIso = null, recent = 25 } = {}) {
  const own = known && known.own ? known.own : new Set();
  const calls = {};
  const rows = [];
  for (const f of files || []) {
    const s = f && f.summary;
    if (!s) continue;
    for (const [k, n] of Object.entries(s.calls || {})) calls[k] = (calls[k] || 0) + n;
    for (const r of s.rows || []) if (!fromIso || !r.t || r.t >= fromIso) rows.push(r);
  }
  rows.sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')));

  const settles = rows.filter((r) => r.step === 'settle');
  const verifies = rows.filter((r) => r.step === 'verify');
  const ok = settles.filter((r) => r.ok);
  const refusedReasons = {};
  for (const r of settles) if (!r.ok) refusedReasons[r.reason || `status ${r.status}`] = (refusedReasons[r.reason || `status ${r.status}`] || 0) + 1;

  const sellers = new Map();
  for (const r of settles) {
    const key = r.pay_to || '?';
    if (!sellers.has(key)) sellers.set(key, { pay_to: key, own: own.has(String(key).toLowerCase()), settled: 0, refused: 0, usd: 0, free: 0, credits: 0, payers: new Set(), last: r.t || null });
    const s = sellers.get(key);
    if (r.ok) {
      s.settled += 1;
      s.usd += usdOf(r.amount);
      if (r.via === 'free') s.free += 1;
      if (r.via === 'credits') s.credits += 1;
      if (r.payer) s.payers.add(r.payer);
    } else {
      s.refused += 1;
    }
  }
  const sellerList = [...sellers.values()]
    .map((s) => ({ ...s, usd: round(s.usd), payers: s.payers.size }))
    .sort((a, b) => b.settled - a.settled || b.refused - a.refused);
  const outside = sellerList.filter((s) => !s.own);

  return {
    calls,
    settles: {
      ok: ok.length,
      refused: settles.length - ok.length,
      refused_reasons: Object.entries(refusedReasons).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
      free: ok.filter((r) => r.via === 'free').length,
      credits: ok.filter((r) => r.via === 'credits').length,
      usd: round(ok.reduce((sum, r) => sum + usdOf(r.amount), 0)),
      payers: new Set(ok.map((r) => r.payer).filter(Boolean)).size,
    },
    verifies: { ok: verifies.filter((r) => r.ok).length, invalid: verifies.filter((r) => !r.ok).length },
    sellers: sellerList,
    outside_sellers: outside.length,
    outside_settled: outside.reduce((n, s) => n + s.settled, 0),
    recent: settles.slice(0, recent).map((r) => ({ ...r, own: own.has(String(r.pay_to || '').toLowerCase()) })),
  };
}

module.exports = { facilitatorOf, summarizeFacilitator };
