// Is a seller's on-chain traffic broad demand or a few operators? Payments and payers alone can't tell: on 2 Nov 2026
// one payout address on Base had 480,000 payments from 5,629 wallets in a week, but 87% of those wallets paid on one day
// only, at dozens to hundreds of calls each, which looks more like a few parties running many wallets than like buyers
// (AILN on X: "stickiness and a small operator set can look the same"). TypeSafe's Jev weighs the shape of the payer
// set (lib/onchain-payments.js demandOf) and says how likely a few operators drive it.
//
// The answer is an info line, never a verdict: operators can be legitimate (an agent platform with a wallet per user).
// Cached per payout address and data day. Off without TYPESAFE_API_KEY (JEV_CHECK=off turns it off again); too little
// traffic to judge, or any failure, gives null.
'use strict';

const API = 'https://api.typesafe.ai/v1/systemone';
const MIN_PAYERS = 10;
const MIN_PAYMENTS = 100;
const SURE = 0.7; // few_operators at or above, broad at or below 1 - SURE

const QUESTIONS = {
  operators: {
    type: 'noul',
    instructions: 'These numbers describe the on-chain x402 payments to one seller\'s payout address over `days` days. Is this traffic most likely driven by a few operators (one party running many wallets, a bot, or the seller itself) rather than by many independent buyers? Signs of a few operators: most wallets pay on one day only and never come back (`payers_one_day_pct` high), each wallet pays dozens or hundreds of times a day (`payments_per_payer_day` high), many payers also pay many other sellers (`payers_wide`), or the seller pays its payers back (`payers_paid_back`, `closed_loop`). Signs of broad demand: many wallets that come back on several days (`payers_every_day`), with a modest number of payments each.',
    criteria: { true: 'A few operators drive most of this traffic', false: 'Many independent buyers drive it' },
  },
};

function stateOf(w) {
  const d = w?.demand;
  if (!d || !(w.payers >= MIN_PAYERS) || !(w.payments >= MIN_PAYMENTS)) return null;
  return {
    days: w.days, payments: w.payments, payers: w.payers, usd: w.usd,
    payers_one_day_pct: d.payers_one_day_pct, payers_every_day: d.payers_every_day ?? null, payments_per_payer_day: d.payments_per_payer_day,
    payers_wide: w.payers_wide || 0, payers_paid_back: w.payers_paid_back || 0, closed_loop: Boolean(w.closed_loop),
  };
}

const labelOf = (p) => (p >= SURE ? 'few_operators' : p <= 1 - SURE ? 'broad' : 'mixed');

function createDemand({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, timeoutMs = 2500, model = process.env.JEV_MODEL || 'jev-latest', max = 2000, log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== 'off';
  const cache = new Map();
  const key = (w) => `${w.network}|${w.pay_to}|${w.as_of}`;

  // { operators, label } for a window from lib/onchain-payments.js windowOf, or null.
  async function judge(w) {
    if (!enabled) return null;
    const state = stateOf(w);
    if (!state) return null;
    const k = key(w);
    if (cache.has(k)) return cache.get(k);
    try {
      const res = await fetchImpl(API, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state, questions: QUESTIONS }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { log.warn?.(`[jev-demand] HTTP ${res.status}`); return null; }
      const v = (await res.json())?.answers?.operators?.noul;
      if (typeof v !== 'number') return null;
      const value = { operators: Math.round(v * 100) / 100, label: labelOf(v) };
      if (cache.size >= max) cache.delete(cache.keys().next().value);
      cache.set(k, value);
      return value;
    } catch (err) {
      log.warn?.(`[jev-demand] ${err.name}: ${err.message}`);
      return null;
    }
  }

  // The answer already known for a window, without asking (for lists).
  const known = (w) => (w ? cache.get(key(w)) ?? null : null);

  return { enabled, judge, known };
}

// The sentence the preflight adds.
function demandNote(w, j) {
  const d = w?.demand;
  if (!d || !j) return '';
  const shape = `${d.payers_one_day_pct}% of these wallets paid on one day only${d.payers_every_day != null ? `, ${d.payers_every_day} paid every day` : ''}, ${d.payments_per_payer_day} payments per wallet per day`;
  if (j.label === 'few_operators') return ` ${shape}: this looks more like a few operators running many wallets than like many independent buyers (judged by TypeSafe Jev).`;
  if (j.label === 'broad') return ` ${shape}: this looks like many independent buyers (judged by TypeSafe Jev).`;
  return ` ${shape}.`;
}

module.exports = { createDemand, demandNote, stateOf, labelOf, QUESTIONS, MIN_PAYERS, MIN_PAYMENTS };
