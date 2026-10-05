// Is a broken endpoint worth an outreach mail? TypeSafe's Jev judges two things the checks can't:
// whether the endpoint is a test, preview, tunnel or placeholder service, and whether its findings
// would really hurt a paying agent (payments failing, paying the wrong place) rather than being
// cosmetic or a deliberate setup, such as the owner serving the API under its own second domain.
// Used by the outreach hook (no draft for test services or harmless findings) and by
// scripts/triage-candidates.js (the Trust Index candidates).
//
// Addresses that are plainly test or preview services (staging., sandbox., testnet, ngrok, trycloudflare,
// Vercel preview deployments) are decided by code, without asking Jev, and so are findings that are a real
// problem whatever the context (ruleOf). When Jev is in between, Claude
// decides (ANTHROPIC_API_KEY); without it the case stays "unsure" (worth: null) and the owner decides.
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

// Words in the host name (the top-level domain left out, so *.dev hosting doesn't count), tunnels and
// Vercel preview deployments (project-<9 chars>-team.vercel.app).
const TEST_WORD = /(^|[.-])(staging|stage|sandbox|testnet|test|preview|demo)([.-]|$)/i;
const TEST_HOST = /\.ngrok(-free)?\.(app|dev|io)$|\.trycloudflare\.com$|-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$|^localhost$/i;

// A test service by its address alone, or null when the address doesn't say.
function testByAddress(url) {
  try {
    const host = new URL(url).hostname;
    return TEST_HOST.test(host) || TEST_WORD.test(host.split('.').slice(0, -1).join('.')) ? host : null;
  } catch { return null; }
}

// Findings that are a real problem for a paying agent whatever the context: decided by code, not asked.
//   - resource.url on http while the endpoint is https (browser paywalls retry the payment at http);
//   - resource.url naming a private or loopback address, or a raw cloud-function URL behind a custom domain;
//   - a price at least 1.5x what the seller's own OpenAPI advertises;
//   - no payment option that would settle.
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?)/i;
const RAW_CLOUD = /(\.lambda-url\.[a-z0-9-]+\.on\.aws|\.execute-api\.[a-z0-9-]+\.amazonaws\.com|\.cloudfunctions\.net)$/i;
function ruleOf(findings, url) {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  for (const f of findings) {
    const id = String(f.id || ''), m = String(f.message || '');
    if (/resource\.url is http:\/\/\S+ but the endpoint is served over https/i.test(m)) return 'resource.url is http on an https endpoint';
    const declared = /resource\.url (https?:\/\/[^\s]+) differs/i.exec(m)?.[1];
    if (declared) {
      let d = '';
      try { d = new URL(declared).hostname; } catch {}
      if (PRIVATE_HOST.test(d)) return `resource.url names an internal address (${d})`;
      if (RAW_CLOUD.test(d) && !RAW_CLOUD.test(host)) return `resource.url leaks a raw cloud-function address (${d})`;
    }
    const price = /Charges \$([\d.]+) but its OpenAPI advertises \$([\d.]+)/i.exec(m);
    if (price && Number(price[2]) > 0 && Number(price[1]) / Number(price[2]) >= 1.5) return `charges ${(Number(price[1]) / Number(price[2])).toFixed(1).replace(/\.0$/, '')}x the advertised price`;
    if (id === 'no_payable_option' || /No payment option would settle/i.test(m)) return 'no payment option would settle';
  }
  return null;
}

function createTriage({ apiKey = process.env.TYPESAFE_API_KEY, anthropicKey = process.env.ANTHROPIC_API_KEY, claudeModel = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001', fetch: fetchImpl = globalThis.fetch, timeoutMs = 4000, model = process.env.JEV_MODEL || 'jev-latest', log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== 'off';

  // Claude for the in-between cases: { test, real } as booleans, or null.
  async function askClaude(state) {
    if (!anthropicKey) return null;
    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 100,
          system: 'You triage broken paid APIs for an outreach mail. Answer two questions about the given endpoint and findings with true or false, as a JSON object {"test": ..., "real": ...} and nothing else. test: is it a test, demo, preview, tunnel or placeholder service rather than a production API? real: would an AI agent paying it really run into trouble because of the findings (payment failing, money or the paid URL going to the wrong place, an internal address leaking), rather than cosmetic issues or a deliberate setup such as the owner naming its own other domain for the same API?',
          messages: [{ role: 'user', content: JSON.stringify(state) }],
        }),
        signal: AbortSignal.timeout(timeoutMs * 2),
      });
      if (!res.ok) return null;
      const text = (await res.json())?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      return typeof j.test === 'boolean' && typeof j.real === 'boolean' ? j : null;
    } catch { return null; }
  }

  // findings: [{ id, message }]. Returns { test, real, worth, why } or null (off / failed).
  async function judge({ url, findings }) {
    if (!enabled || !url || !Array.isArray(findings) || !findings.length) return null;
    const testHost = testByAddress(url);
    if (testHost) return { test: 1, real: null, worth: false, why: `test or preview address (${testHost})`, decidedBy: 'address' };
    const rule = ruleOf(findings, url);
    if (rule) return { test: null, real: 1, worth: true, why: rule, decidedBy: 'rule' };
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
      const r2 = (v) => Math.round(v * 100) / 100;
      const base = { test: r2(test), real: r2(real) };
      // Thresholds are starting values. Jev decides when clearly sure; in between, Claude decides.
      if (test >= 0.8) return { ...base, worth: false, why: `looks like a test or preview service (${Math.round(test * 100)}%)`, decidedBy: 'jev' };
      if (real <= 0.2) return { ...base, worth: false, why: `findings look harmless or deliberate (${Math.round((1 - real) * 100)}%)`, decidedBy: 'jev' };
      if (real >= 0.7 && test < 0.5) return { ...base, worth: true, why: `real problem (${Math.round(real * 100)}%)`, decidedBy: 'jev' };
      const c = await askClaude(state);
      if (!c) return { ...base, worth: null, why: `unsure (real problem ${Math.round(real * 100)}%, test ${Math.round(test * 100)}%)`, decidedBy: 'none' };
      const worth = !c.test && c.real;
      return { ...base, worth, why: c.test ? 'test or preview service (Claude)' : c.real ? 'real problem (Claude)' : 'harmless or deliberate (Claude)', decidedBy: 'jev+claude' };
    } catch (err) {
      log.warn?.(`[jev] ${err.name}: ${err.message}`);
      return null;
    }
  }

  return { enabled, judge };
}

module.exports = { createTriage, testByAddress, ruleOf, QUESTIONS };
