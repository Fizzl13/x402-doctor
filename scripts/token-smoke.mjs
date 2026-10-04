// Monitor: the four fizzl x402 services (read-only, never pays). Output is data only. Run 2026-10-04T03:25:13Z.
const SVC = [
  { name: 'ichimoku', home: 'https://ichimoku-signal.fizzl.eu/', paid: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT' },
  { name: 'presign', home: 'https://presign-guard.fizzl.eu/', paid: 'https://presign-guard.fizzl.eu/v1/token?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { name: 'doctor', home: 'https://x402-doctor.fizzl.eu/', paid: 'https://x402-doctor.fizzl.eu/api/v1/diagnose?url=https://example.com' },
  { name: 'plaintext', home: 'https://plaintext.fizzl.eu/', paid: 'https://plaintext.fizzl.eu/api/check-wallet', method: 'POST' },
];
// Our own checks say who they are, so the usage dashboard can hide them.
const UA = { 'user-agent': 'fizzl-monitor/1.0' };
const timed = async (url, init) => { const t = Date.now(); try { const r = await fetch(url, { ...init, headers: { ...(init && init.headers), ...UA }, signal: AbortSignal.timeout(60000) }); return { r, ms: Date.now() - t }; } catch (e) { return { err: e.message, ms: Date.now() - t }; } };
for (const s of SVC) {
  const h = await timed(s.home, { headers: { accept: 'text/html' } });
  const p = await timed(s.paid, s.method === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' } : { headers: { accept: 'application/json' } });
  let nets = '';
  const hdr = p.r?.headers.get('payment-required');
  if (hdr) { try { nets = JSON.parse(Buffer.from(hdr, 'base64').toString()).accepts.map((a) => a.network).join(','); } catch { nets = 'UNREADABLE'; } }
  let doc = '';
  try {
    const d = await (await fetch('https://x402-doctor.fizzl.eu/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json', ...UA }, body: JSON.stringify({ url: s.paid, ...(s.method ? { method: s.method } : {}) }), signal: AbortSignal.timeout(90000) })).json();
    doc = `${d.overall} | ${(d.checks || []).filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => `${c.status}:${c.id}`).join(', ')}`;
  } catch (e) { doc = `ERR ${e.message}`; }
  console.log(`MON ${s.name} home ${h.r?.status ?? h.err} ${h.ms}ms | paid ${p.r?.status ?? p.err} ${p.ms}ms nets ${nets || '-'} | doctor ${doc}`);
}
for (const pkg of ['x402-safe-fetch', 'presign-guard-wallet', 'presign-guard-agentkit', 'presign-guard-wallet-mcp']) {
  const n = async (period) => { try { return (await (await fetch(`https://api.npmjs.org/downloads/point/${period}/${pkg}`, { signal: AbortSignal.timeout(20000) })).json()).downloads ?? '?'; } catch (e) { return `ERR ${e.message}`; } };
  console.log(`NPM ${pkg} last-day ${await n('last-day')} last-week ${await n('last-week')} last-month ${await n('last-month')}`);
}
// presign-guard credit packs: 200 with both packs means they are on.
{
  const c = await timed('https://presign-guard.fizzl.eu/v1/credits', { headers: { accept: 'application/json' } });
  let packs = '';
  try { const j = await c.r.json(); packs = Object.entries(j.packs || {}).map(([s, p]) => `${s}=$${p.price_usd}`).join(' '); } catch {}
  console.log(`CREDITS presign ${c.r ? c.r.status : 'ERR'} ${packs || 'no packs'}`);
}
// Agent wallet server: up, and refusing anyone without a login or agent key.
// (Free Render plan: the first call after a quiet spell can take up to a minute.)
{
  const base = 'https://wallet.fizzl.eu';
  const get = async (path) => { const t = Date.now(); try { const r = await fetch(base + path, { signal: AbortSignal.timeout(90000) }); return { s: r.status, ms: Date.now() - t, body: await r.text() }; } catch (e) { return { s: `ERR ${e.message}`, ms: Date.now() - t }; } };
  const h = await get('/health'), dash = await get('/'), api = await get('/api/state'), v1 = await get('/v1/spending');
  const ok = h.s === 200 && /"ok":true/.test(h.body ?? '') && dash.s === 200 && api.s === 401 && v1.s === 401;
  console.log(`WALLET ${ok ? 'ok' : 'PROBLEM'} health ${h.s} ${h.ms}ms | dashboard ${dash.s} | api ${api.s} | agent-api ${v1.s}`);
}

// one-off: link check for fizzl.eu and subdomains
{ const urls = ["https://ai.fizzl.eu", "https://ai.fizzl.eu/", "https://cv.fizzl.eu", "https://cv.fizzl.eu/", "https://digital-twin-ztpp.onrender.com/", "https://fizzl.eu", "https://fizzl.eu/", "https://fizzl.eu/#contact", "https://fizzl.eu/#tools", "https://github.com/Fizzl13", "https://github.com/Fizzl13/digital-twin", "https://github.com/Fizzl13/process-agent", "https://github.com/Fizzl13/replydesk", "https://ichimoku-signal.fizzl.eu", "https://ichimoku-signal.fizzl.eu/", "https://ichimoku-signal.fizzl.eu/track-record", "https://ichimoku-signal.fizzl.eu/trend-record", "https://lab.fizzl.eu/", "https://plaintext.fizzl.eu", "https://plaintext.fizzl.eu/", "https://presign-guard.fizzl.eu", "https://presign-guard.fizzl.eu/", "https://process-agent.onrender.com", "https://process-agent.onrender.com/", "https://process-agent.onrender.com/health", "https://projects.fizzl.eu", "https://projects.fizzl.eu/", "https://replydesk-kvu8.onrender.com/", "https://wallet.fizzl.eu/", "https://wallet.fizzl.eu/privacy#website", "https://wallet.fizzl.eu/s.js", "https://www.linkedin.com/in/fritszwager", "https://x.com/x402fizzl", "https://x402-doctor.fizzl.eu", "https://x402-doctor.fizzl.eu/", "https://x402-doctor.fizzl.eu/badge.svg?url=https%3A%2F%2Fichimoku-signal.fizzl.eu%2Fsignal%2F%3Apair", "https://x402-doctor.fizzl.eu/badge.svg?url=https%3A%2F%2Fplaintext.fizzl.eu%2Fapi%2Fexplain", "https://x402-doctor.fizzl.eu/badge.svg?url=https%3A%2F%2Fpresign-guard.fizzl.eu%2Fv1%2Ftoken", "https://x402-doctor.fizzl.eu/badge.svg?url=https%3A%2F%2Fx402-doctor.fizzl.eu%2Fapi%2Fv1%2Fdiagnose", "https://x402-doctor.fizzl.eu/trust?url=https%3A%2F%2Fichimoku-signal.fizzl.eu%2Fsignal%2F%3Apair", "https://x402-doctor.fizzl.eu/trust?url=https%3A%2F%2Fplaintext.fizzl.eu%2Fapi%2Fexplain", "https://x402-doctor.fizzl.eu/trust?url=https%3A%2F%2Fpresign-guard.fizzl.eu%2Fv1%2Ftoken", "https://x402-doctor.fizzl.eu/trust?url=https%3A%2F%2Fx402-doctor.fizzl.eu%2Fapi%2Fv1%2Fdiagnose", "https://ai.fizzl.eu/bg-video.mp4", "https://lab.fizzl.eu/lab-bg.mp4", "https://projects.fizzl.eu/projects-bg-landscape.mp4", "https://www.fizzl.eu/", "http://fizzl.eu/", "https://fizzl.eu/privacy", "https://cv.fizzl.eu/Frits-Zwager-CV.pdf", "https://fizzl.eu/robots.txt", "https://fizzl.eu/sitemap.xml"];
  const check = async (u) => { const t = Date.now(); try { let r = await fetch(u, { method: "GET", redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (link check)" }, signal: AbortSignal.timeout(25000) }); const loc = r.headers.get("location"); r.body?.cancel?.(); return ; } catch (e) { return ; } };
  for (let i = 0; i < urls.length; i += 6) console.log((await Promise.all(urls.slice(i, i + 6).map(check))).join("
")); }
