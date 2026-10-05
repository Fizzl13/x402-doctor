// Drafts for the owner's outreach: when the free check finds a broken endpoint (a fail) and the seller
// publishes a contact address in its /openapi.json (info.contact.email), hand a draft to the wallet
// server (OUTREACH_URL, OUTREACH_KEY). The wallet server only makes a draft: the owner reads it on
// Telegram or the dashboard and decides whether it is sent (one mail per address, ever).
// Off without both settings; never slows down or changes the check's answer; Fizzl's own hosts and
// hosts tried in the last day are skipped. With TYPESAFE_API_KEY, Jev holds back drafts for test services
// and harmless findings (lib/jev-triage.js).
'use strict';

const EMAIL_RE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[a-z]{2,24}$/i;
const DAY = 86_400_000;

function createOutreachHook({ url, key, safeFetch, fetch: fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), publicUrl = 'https://x402-doctor.fizzl.eu', triage = null } = {}) {
  const tried = new Map(); // host -> when
  const on = Boolean(url && key && safeFetch);
  if (safeFetch) log.log?.(on ? `[outreach] drafts for broken endpoints go to ${url}` : `[outreach] off: ${!url ? 'OUTREACH_URL' : 'OUTREACH_KEY'} not set`);

  async function contactOf(origin) {
    const res = await safeFetch(`${origin}/openapi.json`);
    if (res.status !== 200 || res.truncated) return null;
    let spec;
    try { spec = JSON.parse(res.text); } catch { return null; }
    const email = String(spec?.info?.contact?.email ?? '').trim();
    return EMAIL_RE.test(email) ? email : null;
  }

  // Fire and forget: returns a promise for tests, callers don't await it. Every outcome is logged on one line.
  async function maybeDraft(targetUrl, report) {
    const out = await attempt(targetUrl, report);
    if (out.skipped !== 'off_or_not_failing' && out.skipped !== 'own') log.log?.(`[outreach] ${out.host ?? targetUrl}: ${out.drafted ? 'draft made (waiting for you on Telegram / the dashboard)' : `no draft (${out.skipped}${out.status ? ` HTTP ${out.status}` : ''})`}`);
    return out.drafted ? { drafted: out.drafted } : { skipped: out.skipped, ...(out.status ? { status: out.status } : {}) };
  }

  async function attempt(targetUrl, report) {
    if (!on || !report || report.overall !== 'fail') return { skipped: 'off_or_not_failing' };
    let u;
    try { u = new URL(targetUrl); } catch { return { skipped: 'bad_url' }; }
    const host = u.hostname.toLowerCase();
    if (host === 'fizzl.eu' || host.endsWith('.fizzl.eu') || host.endsWith('.onrender.com')) return { skipped: 'own' };
    for (const [h, t] of tried) if (now() - t > DAY) tried.delete(h);
    if (tried.has(host)) return { host, skipped: 'already tried today' };
    tried.set(host, now());
    const findings = (report.checks || []).filter((c) => c.status === 'fail').map((c) => ({ id: c.id, message: c.message, hint: c.hint || null }));
    if (!findings.length) return { host, skipped: 'no_fails' };
    // Jev (lib/jev-triage.js): no draft for a test or preview service, or for findings that wouldn't hurt a
    // paying agent. Off or failing: drafts as before.
    const verdict = triage?.enabled ? await triage.judge({ url: targetUrl, findings }) : null;
    if (verdict && verdict.worth === false) return { host, skipped: `Jev: ${verdict.why}` };
    try {
      const to = await contactOf(u.origin);
      if (!to) return { host, skipped: 'no contact e-mail in /openapi.json info.contact' };
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/hooks/outreach-draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ url: targetUrl, to, findings, reportUrl: `${publicUrl}/?url=${encodeURIComponent(targetUrl)}` }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return { host, skipped: res.status === 401 ? 'refused: OUTREACH_KEY differs from the wallet server' : 'refused by the wallet server', status: res.status };
      return body?.draft ? { host, drafted: host } : { host, skipped: body?.message || body?.skipped || 'unknown' };
    } catch (err) {
      return { host, skipped: `wallet server not reached: ${err.message}` };
    }
  }

  return { enabled: on, maybeDraft };
}

module.exports = { createOutreachHook };
