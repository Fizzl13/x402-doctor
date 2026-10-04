// Drafts for the owner's outreach: when the free check finds a broken endpoint (a fail) and the seller
// publishes a contact address in its /openapi.json (info.contact.email), hand a draft to the wallet
// server (OUTREACH_URL, OUTREACH_KEY). The wallet server only makes a draft: the owner reads it on
// Telegram or the dashboard and decides whether it is sent (one mail per address, ever).
// Off without both settings; never slows down or changes the check's answer; Fizzl's own hosts and
// hosts tried in the last day are skipped.
'use strict';

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[a-z]{2,24}$/i;
const DAY = 86_400_000;

function createOutreachHook({ url, key, safeFetch, fetch: fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), publicUrl = 'https://x402-doctor.fizzl.eu' } = {}) {
  const tried = new Map(); // host -> when
  const on = Boolean(url && key && safeFetch);

  async function contactOf(origin) {
    const res = await safeFetch(`${origin}/openapi.json`);
    if (res.status !== 200 || res.truncated) return null;
    let spec;
    try { spec = JSON.parse(res.text); } catch { return null; }
    const email = String(spec?.info?.contact?.email ?? '').trim();
    return EMAIL_RE.test(email) ? email : null;
  }

  // Fire and forget: returns a promise for tests, callers don't await it.
  async function maybeDraft(targetUrl, report) {
    if (!on || !report || report.overall !== 'fail') return { skipped: 'off_or_not_failing' };
    let u;
    try { u = new URL(targetUrl); } catch { return { skipped: 'bad_url' }; }
    const host = u.hostname.toLowerCase();
    if (host === 'fizzl.eu' || host.endsWith('.fizzl.eu') || host.endsWith('.onrender.com')) return { skipped: 'own' };
    for (const [h, t] of tried) if (now() - t > DAY) tried.delete(h);
    if (tried.has(host)) return { skipped: 'recent' };
    tried.set(host, now());
    const findings = (report.checks || []).filter((c) => c.status === 'fail').map((c) => ({ id: c.id, message: c.message, hint: c.hint || null }));
    if (!findings.length) return { skipped: 'no_fails' };
    try {
      const to = await contactOf(u.origin);
      if (!to) return { skipped: 'no_contact' };
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/hooks/outreach-draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ url: targetUrl, to, findings, reportUrl: `${publicUrl}/?url=${encodeURIComponent(targetUrl)}` }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { log.warn(`[outreach] draft for ${host} refused: HTTP ${res.status}`); return { skipped: 'refused', status: res.status }; }
      return body?.draft ? { drafted: host } : { skipped: body?.skipped || 'unknown' };
    } catch (err) {
      log.warn(`[outreach] draft for ${host} failed: ${err.message}`);
      return { skipped: 'error' };
    }
  }

  return { enabled: on, maybeDraft };
}

module.exports = { createOutreachHook };
