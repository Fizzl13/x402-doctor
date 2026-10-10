// Where to reach a seller about a broken endpoint, for the owner's outreach drafts (lib/outreach-hook.js and
// scripts/triage-candidates.js). Only addresses the seller publishes for that purpose, tried in order:
//   1. /openapi.json info.contact.email (the API's own contact)
//   2. /.well-known/x402: a contact e-mail in the seller's x402 manifest
//   3. /.well-known/security.txt: its Contact: mailto: line (the standard place to report a problem)
//   4. the homepage: a mailto: link
// Placeholder and no-reply addresses are skipped. Returns { email, source } or null; never throws.
'use strict';

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[a-z]{2,24}$/i;
const PLACEHOLDER = /(^|[.@])(example|domain|email|yourdomain|yourcompany|company|test)\.(com|org|net|io)$|@sentry|^(no-?reply|donotreply|do-not-reply|mailer-daemon|user|you|your-?email|name)@|\.(png|jpe?g|gif|svg|webp)$/i;

const usable = (email) => {
  const e = String(email || '').trim().replace(/^mailto:/i, '').split('?')[0].toLowerCase();
  return EMAIL_RE.test(e) && !PLACEHOLDER.test(e) ? e : null;
};

// The first usable address anywhere in a JSON value (keys named like contact/email/support first).
function fromJson(value) {
  const found = [];
  const walk = (v, key = '', depth = 0) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') { const e = usable(v); if (e) found.push({ e, rank: /contact|email|support|owner/i.test(key) ? 0 : 1 }); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(value);
  found.sort((a, b) => a.rank - b.rank);
  return found[0]?.e ?? null;
}

async function findContact(safeFetch, origin) {
  const get = async (path) => {
    try {
      const res = await safeFetch(`${origin}${path}`);
      return res.status === 200 && !res.truncated ? String(res.text || '') : '';
    } catch { return ''; }
  };
  const openapi = await get('/openapi.json');
  if (openapi) { try { const e = usable(JSON.parse(openapi)?.info?.contact?.email); if (e) return { email: e, source: 'openapi.json' }; } catch {} }
  const manifest = await get('/.well-known/x402');
  if (manifest) { try { const e = fromJson(JSON.parse(manifest)); if (e) return { email: e, source: '.well-known/x402' }; } catch {} }
  const security = await get('/.well-known/security.txt');
  for (const m of security.matchAll(/^Contact:\s*(mailto:\S+)/gim)) { const e = usable(m[1]); if (e) return { email: e, source: 'security.txt' }; }
  const home = await get('/');
  for (const m of home.matchAll(/href\s*=\s*["']mailto:([^"'?\s>]+)/gi)) { let raw = m[1]; try { raw = decodeURIComponent(raw); } catch {} const e = usable(raw); if (e) return { email: e, source: 'homepage' }; }
  return null;
}

module.exports = { findContact, usable };
