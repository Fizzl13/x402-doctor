// Monitor: the four fizzl x402 services (read-only, never pays). Output is data only. Run 2026-10-03T18:23:32Z.
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
// one-off: free stock data sources
for (const u of ["https://stooq.com/q/d/l/?s=aapl.us&i=d", "https://stooq.com/q/d/l/?s=spy.us&i=d", "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=3mo&interval=1d"]) {
  try { const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" } }); const t = await r.text(); console.log("STOCK", r.status, u, JSON.stringify(t.slice(0, 160)), "len", t.length); } catch (e) { console.log("STOCK ERR", u, e.message); }
}
try { const r = await fetch("https://api.kraken.com/0/public/AssetPairs"); const j = await r.json(); const x = Object.entries(j.result || {}).filter(([k, v]) => /x\/|X\//.test(v.wsname || "") && /USD/.test(v.wsname || "")).map(([k, v]) => `${k}=${v.wsname}`); console.log("KRAKEN xstocks", x.length, x.slice(0, 80).join(" ")); } catch (e) { console.log("KRAKEN ERR", e.message); }
try { const r = await fetch("https://api.kraken.com/0/public/OHLC?pair=AAPLxUSD&interval=1440"); console.log("KRAKEN OHLC", r.status, (await r.text()).slice(0, 300)); } catch (e) { console.log("KRAKEN OHLC ERR", e.message); }
