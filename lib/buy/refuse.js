'use strict';

// Needs Fizzl Buy doesn't pick or buy for, whatever a seller offers: a private person's personal data (home address,
// phone number, personal e-mail, ID numbers) and breaking into things (bypassing a paywall or a login, stolen or leaked
// credentials, card data). Grok's red team of 31 Oct 2026 asked x402_pick for a famous person's "private home address
// and phone number" and got a property-listing API. Refused before any search or payment, for the free pick, the
// purchase and the MCP tools alike. Plain words only: a refusal is a reason to stop, not a score.

const RULES = [
  {
    id: 'personal_data',
    reason: 'a private person\'s personal data (home address, phone number, personal e-mail or ID numbers)',
    test: (s) => /\b(home|private|personal|residential|house)\s+(street\s+)?(address|addresses|phone|number|e-?mail|location)\b/.test(s)
      || /\b(where (does|do) \w+ live|dox+(ing)?|doxx?)\b/.test(s)
      || /\b(social security|ssn|passport|national id|id card|driver'?s licen[cs]e)\s+(number|numbers|no\.?)\b/.test(s)
      || /\b(phone|mobile|cell)\s+(number|numbers|no\.?)\s+(of|for)\s+[a-z]+\s+[a-z]+/.test(s) && !/\b(customer service|support|office|company|business|helpline|hotline|store|shop|restaurant|hotel|embassy|police|hospital)\b/.test(s),
  },
  {
    id: 'break_in',
    reason: 'getting around a paywall or a login, or stolen or leaked credentials and card data',
    test: (s) => /\b(bypass|circumvent|get around|remove)\s+(a |the )?(paywall|login|captcha|drm|2fa|two[- ]factor)\b/.test(s)
      || /\b(hack|break)\s+into\b/.test(s)
      || /\b(stolen|leaked|dumped|cracked)\s+(passwords?|credentials|accounts?|logins?|credit cards?|cards?|database)\b/.test(s)
      || /\b(carding|cvv dumps?|fullz)\b/.test(s),
  },
];

// The need in plain lowercase letters: NFKC, look-alike Cyrillic and Greek letters to Latin, spaced letters joined.
const HOMOGLYPHS = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ο: 'o', α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ρ: 'p', τ: 't', υ: 'u', χ: 'x' };
function plain(need) {
  let s = String(need || '').normalize('NFKC').toLowerCase();
  s = s.replace(/[Ͱ-ϿЀ-ӿ]/g, (c) => HOMOGLYPHS[c] ?? c);
  s = s.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (m) => m.replace(/ /g, ''));
  return s.replace(/\s+/g, ' ');
}

// { id, reason } when Fizzl Buy won't pick or buy for this need, else null.
function refusalFor(need) {
  const s = plain(need);
  const rule = RULES.find((r) => r.test(s));
  return rule ? { id: rule.id, reason: rule.reason } : null;
}

module.exports = { refusalFor, plain };
