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
// one-off: live MPP challenges from mpp.dev/api/services (read-only, no credential)
{ const d = await (await fetch("https://mpp.dev/api/services")).json();
  const list = Array.isArray(d) ? d : d.services ?? d.items ?? d.data ?? [];
  console.log("MPPAPI keys", Array.isArray(d) ? "array" : Object.keys(d).join(","), "n", list.length, "sample", JSON.stringify(list[0] ?? {}).slice(0, 600));
  const cands = [];
  for (const s of list) {
    const base = s.serviceUrl ?? s.url ?? s.baseUrl ?? s.endpoint ?? s.origin;
    for (const e of s.endpoints ?? s.routes ?? []) {
      const path = e.path ?? e.route ?? e.url; const method = (e.method ?? "GET").toUpperCase();
      if (base && path && !/\{|:/.test(path.replace(/^https?:/, ""))) cands.push([new URL(path, base).href, method]);
    }
  }
  console.log("MPPAPI endpoints", cands.length);
  let shown = 0;
  for (const [u, m] of cands.slice(0, 120)) {
    const r = await fetch(u, { method: m, headers: m === "GET" ? {} : { "content-type": "application/json" }, body: m === "GET" ? undefined : "{}", signal: AbortSignal.timeout(8000) }).catch(() => null);
    const w = r?.headers.get("www-authenticate");
    if (r?.status === 402 && w && /Payment\s/i.test(w)) { console.log("MPPLIVE", m, u, "| x402:", !!r.headers.get("payment-required"), "|", w.slice(0, 500)); if (++shown >= 6) break; }
  }
  console.log("MPPAPI live shown", shown);
}
