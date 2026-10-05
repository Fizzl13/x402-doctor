// Is a broken endpoint worth an outreach mail? TypeSafe's Jev judges two things the checks can't:
// whether the endpoint is a test, preview, tunnel or placeholder service, and whether its findings
// would really hurt a paying agent (payments failing, paying the wrong place) rather than being
// cosmetic or a deliberate setup, such as the owner serving the API under its own second domain.
// Used by the outreach hook (no draft for test services or harmless findings) and by
// scripts/triage-candidates.js (the Trust Index candidates).
//
// Off without TYPESAFE_API_KEY. Any failure returns null, and callers then behave as before.
'use strict';

const API = 'https://api.typesafe.ai/v1/systemone';

const QUESTIONS = {
  test_service: {
    type: 'noul',
    instructions: 'Is `endpoint` a test, demo, preview, temporary tunnel (such as ngrok or trycloudflare) or placeholder service, rather than a production paid API that someone runs for real customers?',
    criteria: { true: 'Clearly a test, preview, tunnel, sandbox or placeholder', false: 'Looks like a production API on its own domain or a normal hosting address' },
  },
  real_problem: {
    type: 'noul',
    instructions: 'Would an AI agent that pays `endpoint` really run into trouble because of `findings`: a payment that fails or cannot be made, money going to the wrong address, the wrong URL being paid for, an internal address leaking, or a challenge it cannot read? Answer no when the findings are cosmetic or describe a deliberate setup, such as the owner naming its own other domain or subdomain for the same API.',
    criteria: { true: 'At least one finding would make paying fail or go wrong', false: 'The findings are harmless, cosmetic or a deliberate setup by the owner' },
  },
};

function createTriage({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, timeoutMs = 4000, model = process.env.JEV_MODEL || 'jev-latest', log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== 'off';

  // findings: [{ id, message }]. Returns { test, real, worth, why } or null (off / failed).
  async function judge({ url, findings }) {
    if (!enabled || !url || !Array.isArray(findings) || !findings.length) return null;
    const state = { endpoint: url, findings: findings.slice(0, 8).map((f) => ({ check: String(f.id || ''), message: String(f.message || '').slice(0, 400) })) };
    try {
      const res = await fetchImpl(API, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state, questions: QUESTIONS }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { log.warn?.(`[jev] HTTP ${res.status}`); return null; }
      const body = await res.json();
      const test = body?.answers?.test_service?.noul;
      const real = body?.answers?.real_problem?.noul;
      if (typeof test !== 'number' || typeof real !== 'number') return null;
      // Thresholds are starting values: a draft is only held back when Jev is clearly sure.
      const worth = !(test >= 0.8 || real <= 0.2);
      const why = test >= 0.8 ? `looks like a test or preview service (${Math.round(test * 100)}%)` : real <= 0.2 ? `findings look harmless or deliberate (${Math.round((1 - real) * 100)}%)` : `real problem ${Math.round(real * 100)}%`;
      return { test: Math.round(test * 100) / 100, real: Math.round(real * 100) / 100, worth, why };
    } catch (err) {
      log.warn?.(`[jev] ${err.name}: ${err.message}`);
      return null;
    }
  }

  return { enabled, judge };
}

module.exports = { createTriage, QUESTIONS };
