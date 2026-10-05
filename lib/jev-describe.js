// How well can an AI agent tell from an endpoint's description what it does, what it returns and when to
// call it? Agents pick services from the Bazaar and other indexes by that one line, so a vague description
// ("API endpoint", "Paid content") loses calls. TypeSafe's Jev rates it; the result is an info line with
// concrete hints, never a warn or fail, so verdicts, badges and the monitor stay as they were.
//
// Opt-in per caller (diagnose({ describe })): the web check and the paid check use it, bulk scans don't.
// Off without TYPESAFE_API_KEY (JEV_CHECK=off turns it off again). Any failure skips the line.
'use strict';

const API = 'https://api.typesafe.ai/v1/systemone';

const QUESTIONS = {
  clarity: {
    type: 'score',
    instructions: 'An AI agent is choosing which paid API to call from a list that shows only `description`. How well can it tell from `description` what the service does, what it returns and when it should call it?',
    criteria: [
      'Not at all: empty, generic or a placeholder (for example "API endpoint" or "Paid content")',
      'Barely: names a topic but not what the service does or returns',
      'Mostly: says what the service does; what it returns or when to use it stays vague',
      'Fully: says what the service does, what it returns and when an agent would call it',
    ],
  },
  says_output: {
    type: 'noul',
    instructions: 'Does `description` say what the response contains (the data, format or result the caller gets back)?',
    criteria: { true: 'The returned data or result is named', false: 'It does not say what comes back' },
  },
  says_when: {
    type: 'noul',
    instructions: 'Does `description` make clear what task or question an agent would call this service for?',
    criteria: { true: 'The use case or task is clear', false: 'It is unclear why or when to call it' },
  },
};

function createDescribe({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, timeoutMs = 2500, model = process.env.JEV_MODEL || 'jev-latest', ttlMs = 24 * 3600e3, max = 500, log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== 'off';
  const cache = new Map();

  // Returns { score (0..3), says_output, says_when } or null (off, empty or failed).
  async function rate(description) {
    const text = typeof description === 'string' ? description.trim().slice(0, 1000) : '';
    if (!enabled || !text) return null;
    const hit = cache.get(text);
    if (hit && hit.at > Date.now() - ttlMs) return hit.value;
    try {
      const res = await fetchImpl(API, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: { description: text }, questions: QUESTIONS }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { log.warn?.(`[jev-describe] HTTP ${res.status}`); return null; }
      const a = (await res.json())?.answers ?? {};
      const score = a.clarity?.score, out = a.says_output?.noul, when = a.says_when?.noul;
      if (typeof score !== 'number' || typeof out !== 'number' || typeof when !== 'number') return null;
      const r2 = (v) => Math.round(v * 100) / 100;
      const value = { score: r2(score), says_output: r2(out), says_when: r2(when) };
      if (cache.size >= max) cache.delete(cache.keys().next().value);
      cache.set(text, { at: Date.now(), value });
      return value;
    } catch (err) {
      log.warn?.(`[jev-describe] ${err.name}: ${err.message}`);
      return null;
    }
  }

  return { enabled, rate };
}

// The check line for one rating: pass when an agent can tell what it gets and why, otherwise info with hints.
function describeCheck(rating, where) {
  if (!rating) return null;
  const hints = [];
  if (rating.says_output < 0.5) hints.push('say what the response contains (for example "returns JSON with price, 24h volume and market cap")');
  if (rating.says_when < 0.5) hints.push('say what task an agent would call it for (for example "use to check a token before a swap")');
  if (rating.score < 2 && !hints.length) hints.push('name what the service does in plain words instead of a generic label');
  const good = rating.score >= 2 && !hints.length;
  const level = rating.score >= 2.5 ? 'clear' : rating.score >= 1.5 ? 'fairly clear' : rating.score >= 0.75 ? 'vague' : 'unclear';
  return {
    id: 'description-quality',
    status: good ? 'pass' : 'info',
    group: 'resource',
    message: good
      ? `${where} is clear to an AI agent: it says what the service returns and when to call it (rated by TypeSafe Jev).`
      : `${where} is ${level} to an AI agent picking a service (rated by TypeSafe Jev). Agents choose from indexes like the Bazaar by this one line.`,
    ...(good ? {} : { hint: `In the description, ${hints.join(', and ')}.` }),
    rating,
  };
}

module.exports = { createDescribe, describeCheck, QUESTIONS };
