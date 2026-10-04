// Monitor: the four fizzl x402 services (read-only, never pays). Output is data only. Run 2026-10-04T21:26Z.
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
{
  const svc = [['x402-doctor.fizzl.eu', '/api/v1/diagnose?url=https://example.com', 'GET'], ['ichimoku-signal.fizzl.eu', '/signal/BTC-USDT', 'GET'], ['presign-guard.fizzl.eu', '/v1/token?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'GET'], ['plaintext.fizzl.eu', '/api/check-wallet', 'POST']];
  for (const [host, path, m] of svc) {
    try {
      const r = await fetch(`https://${host}${path}`, { method: m, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: m === 'POST' ? '{}' : undefined });
      const w = r.headers.get('www-authenticate') || '';
      const ch = [...w.matchAll(/method="([a-z]+)"[^]*?intent="([a-z]+)"/g)].map((x) => x[1] + '/' + x[2]);
      const realms = [...new Set([...w.matchAll(/realm="([^"]+)"/g)].map((x) => x[1]))];
      const o = await (await fetch(`https://${host}/openapi.json`)).text();
      console.log('MPPMON', host, r.status, ch.join(','), realms.length === 1 && realms[0] === host ? 'realm OK' : 'REALM? ' + realms.join(','), 'offers evm', (o.match(/"method":"evm"/g) || []).length, 'tempo', (o.match(/"method":"tempo"/g) || []).length);
    } catch (e) { console.log('MPPMON', host, 'error', e.message); }
  }
  try {
    const h = { headers: { 'user-agent': 'fizzl-monitor' } };
    const p = await (await fetch('https://api.github.com/repos/tempoxyz/mpp/pulls/1045', h)).json();
    const c = await (await fetch('https://api.github.com/repos/tempoxyz/mpp/issues/1045/comments', h)).json();
    const rv = await (await fetch('https://api.github.com/repos/tempoxyz/mpp/pulls/1045/reviews', h)).json();
    console.log('PR1045', p.state, 'merged', p.merged, 'updated', p.updated_at, 'humans', Array.isArray(c) ? c.filter((x) => x.user.type !== 'Bot').map((x) => `${x.user.login}: ${x.body.slice(0, 150)}`).join(' || ') : '?', 'reviews', Array.isArray(rv) ? rv.map((x) => `${x.user.login}:${x.state}`).join(',') : '');
  } catch (e) { console.log('PR1045 error', e.message); }
}
