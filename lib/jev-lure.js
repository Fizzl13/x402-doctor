// Is this paid endpoint bait? Before an agent pays, TypeSafe's Jev judges what the protocol checks can't:
//   1. impersonation: does the service present itself as made by, or official from, a well-known company
//      (Coinbase, OpenAI, Circle, Uniswap …) while it runs on a domain that isn't that company's?
//   2. lure: does it promise free tokens, airdrops, rewards or guaranteed profit instead of offering a service?
//   3. mismatch: do the fields it says it returns (its output example or schema) fit what it promises?
// A clear yes adds a "caution" reason to the preflight, an in-between answer an "info" one. It never makes a
// verdict no_go on its own and never turns a caution into go: the protocol checks decide whether a payment
// can settle, this only says whether it is worth making.
//
// Opt-in per caller (preflight({ lure })): the paid preflight uses it, bulk scans don't. Answers are cached
// per text for a day. Off without TYPESAFE_API_KEY (JEV_CHECK=off turns it off again). Any failure (timeout,
// error, rate limit) skips the check silently: the preflight stands as it was.
'use strict';

const API = 'https://api.typesafe.ai/v1/systemone';

// Brands Jev may see named, with the domains that are really theirs: a service on one of these is the brand.
const BRAND_DOMAINS = [
  'coinbase.com', 'cdp.coinbase.com', 'base.org', 'openai.com', 'anthropic.com', 'circle.com', 'google.com',
  'uniswap.org', 'binance.com', 'stripe.com', 'paypal.com', 'metamask.io', 'phantom.app', 'solana.com', 'ethereum.org',
];

const QUESTIONS = {
  impersonation: {
    type: 'noul',
    instructions: 'Does the paid API at `host` present itself in `description` (or in `host` itself) as made by, official from, or endorsed by a well-known company or brand (for example Coinbase, Base, OpenAI, Anthropic, Circle, Google, Uniswap, Binance, Stripe, MetaMask), while `host` is not a domain of that company? Merely using or reselling data about a brand ("Coinbase price feed via our API", "Uniswap pool stats") is not impersonation; claiming to be the brand ("Official Coinbase API", "OpenAI GPT endpoint") is.',
    criteria: { true: 'It claims to be or come from a brand that does not own this host', false: 'No such claim, or it plainly runs its own service' },
  },
  lure: {
    type: 'noul',
    instructions: 'Does `description` lure a buyer with free tokens, an airdrop, a reward or bonus, guaranteed profit or returns, or "claim"/"unlock" wording, rather than describing a service with a clear result?',
    criteria: { true: 'Bait: promises money, tokens or rewards', false: 'Describes a normal paid service' },
  },
  mismatch: {
    type: 'noul',
    instructions: 'Given what `description` promises, do the fields in `output` (what the API says it returns) fit that promise? Answer yes when they plausibly deliver it, no when they are about something else or obviously cannot.',
    criteria: { true: 'The output fits the description', false: 'The output does not match what is promised' },
  },
};

const ownedBy = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// What a challenge says about itself: the description (v2 resource or v1 accepts[0]) and the output it promises
// (the Bazaar output example, or a v1 outputSchema), trimmed to what Jev needs.
function claimsOf(challenge) {
  if (!challenge) return null;
  const v2 = typeof challenge.resource?.description === 'string' ? challenge.resource.description.trim() : '';
  const description = (v2 || String(challenge.accepts?.[0]?.description ?? '').trim()).slice(0, 1000);
  const example = challenge.extensions?.bazaar?.info?.output?.example;
  const schema = challenge.accepts?.[0]?.outputSchema;
  const raw = example !== undefined ? example : schema;
  let output = '';
  if (raw !== undefined && raw !== null) {
    try { output = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 800); } catch { output = ''; }
  }
  return description ? { description, output } : null;
}

function createLure({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, timeoutMs = 2500, model = process.env.JEV_MODEL || 'jev-latest', ttlMs = 24 * 3600e3, max = 1000, log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== 'off';
  const cache = new Map();

  // Returns { impersonation, lure, mismatch } as probabilities of a problem (mismatch: of NOT fitting), with
  // null for a question that wasn't asked, or null when off, there is nothing to judge, or Jev failed.
  async function judge(host, claims) {
    if (!enabled || !claims?.description) return null;
    const h = String(host || '').toLowerCase();
    const questions = {};
    if (!BRAND_DOMAINS.some((d) => ownedBy(h, d))) questions.impersonation = QUESTIONS.impersonation;
    questions.lure = QUESTIONS.lure;
    if (claims.output) questions.mismatch = QUESTIONS.mismatch;
    const key = JSON.stringify([h, claims.description, claims.output, Object.keys(questions)]);
    const hit = cache.get(key);
    if (hit && hit.at > Date.now() - ttlMs) return hit.value;
    try {
      const res = await fetchImpl(API, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: { host: h, description: claims.description, ...(claims.output ? { output: claims.output } : {}) }, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { log.warn?.(`[jev-lure] HTTP ${res.status}`); return null; }
      const a = (await res.json())?.answers ?? {};
      const p = (name, invert = false) => {
        if (!questions[name]) return null;
        const v = a[name]?.noul;
        if (typeof v !== 'number') return undefined;
        return Math.round((invert ? 1 - v : v) * 100) / 100;
      };
      const value = { impersonation: p('impersonation'), lure: p('lure'), mismatch: p('mismatch', true) };
      if (Object.values(value).includes(undefined)) return null;
      if (cache.size >= max) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      log.warn?.(`[jev-lure] ${err.name}: ${err.message}`);
      return null;
    }
  }

  return { enabled, judge };
}

const MESSAGES = {
  impersonation: {
    caution: 'It presents itself as an official service of a well-known brand that does not own this domain (judged by TypeSafe Jev). Check who runs it before paying.',
    info: 'Its description may present it as a service of a well-known brand that does not own this domain (TypeSafe Jev is unsure).',
  },
  lure: {
    caution: 'Its description lures with free tokens, rewards or guaranteed returns rather than a clear service (judged by TypeSafe Jev). Paid "claim" endpoints are a common bait.',
    info: 'Its description may promise tokens, rewards or returns rather than a clear service (TypeSafe Jev is unsure).',
  },
  mismatch: {
    caution: 'What it says it returns does not match what its description promises (judged by TypeSafe Jev), so the paid answer may not be what you expect.',
    info: 'What it says it returns may not fully match its description (TypeSafe Jev is unsure).',
  },
};
const CODES = { impersonation: 'brand_impersonation', lure: 'lure_description', mismatch: 'output_mismatch' };

// Preflight reasons for one judgement: caution when Jev is sure (>= sure), info when in between (>= unsure).
function lureReasons(judgement, { sure = Number(process.env.JEV_SURE) || 0.85, unsure = Number(process.env.JEV_UNSURE) || 0.5 } = {}) {
  if (!judgement) return [];
  const out = [];
  for (const name of ['impersonation', 'lure', 'mismatch']) {
    const p = judgement[name];
    if (typeof p !== 'number') continue;
    const level = p >= sure ? 'caution' : p >= unsure ? 'info' : null;
    if (level) out.push({ level, code: CODES[name], message: MESSAGES[name][level] });
  }
  return out;
}

module.exports = { createLure, lureReasons, claimsOf, QUESTIONS, BRAND_DOMAINS };
