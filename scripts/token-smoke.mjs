// Monitor: the four fizzl x402 services (read-only, never pays). Output is data only. Run 2026-10-05T03:25Z.
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

// one-off (read-only, no payments): 402 challenges + public contact hints for Trust Index candidates
{
  const cands = [{"u":"https://x402.outpimp.com/isEmail","m":"POST","c":["resource_mismatch"]},{"u":"https://simfuse.app/x402/plans/search","m":"POST","c":["resource_mismatch"]},{"u":"https://automatoncolony.xyz/api/v1/x402/flash-audit","m":"POST","c":["resource_mismatch"]},{"u":"https://extract.tollkit.dev/read","m":"POST","c":["resource_mismatch"]},{"u":"https://api.grip.fyi/v1/embed","m":"POST","c":["resource_mismatch"]},{"u":"https://oblique.markets/api/v1/paid/bazaar-pulse","m":"GET","c":["resource_mismatch"]},{"u":"https://twit-api-production-de12.up.railway.app/tweets/user","m":"GET","c":["resource_mismatch"]},{"u":"https://conc-exe.xyz/api/concierge-security-headers","m":"POST","c":["invalid_challenge"]},{"u":"https://animica.dev/x402/security/injection","m":"POST","c":["price_above_advertised"]},{"u":"https://api.blockchain.info/explorer-gateway-kt/x402/charts/pools","m":"POST","c":["unknown_asset"]},{"u":"https://ausca.com/v1/lease-browser","m":"POST","c":["unknown_asset"]},{"u":"https://verify.code402.dev/v1/chain/block-number","m":"GET","c":["unknown_asset"]},{"u":"https://api.getemboss.ai/pay/fill","m":"POST","c":["unknown_asset"]},{"u":"https://app.tenna.ai/api/x402/tenna/hyperboost_graduation_receipt","m":"POST","c":["unknown_asset"]},{"u":"https://api.sirenic.eu/v1/entreprise/:siren","m":"GET","c":["resource_mismatch"]},{"u":"https://x402-factory.com/v1/edge/:slug","m":"GET","c":["resource_mismatch"]},{"u":"https://whaletape.xyz/whale/:address","m":"GET","c":["resource_mismatch"]},{"u":"https://api.onesource.io/deepstate/v1/candles/:book","m":"GET","c":["resource_mismatch"]},{"u":"https://api.robinx.io/token/:address","m":"GET","c":["resource_mismatch"]},{"u":"https://www.vokko.eu/api/v1/hosts/:domain","m":"GET","c":["resource_mismatch"]},{"u":"https://gibai.app/activity/:name","m":"GET","c":["resource_mismatch"]},{"u":"https://47620.xyz/x/solana-fac/should-pay/:solana_address","m":"GET","c":["no_402"]},{"u":"https://api.brazilayer.com/v1/cnpj/situacao/:cnpj","m":"GET","c":["resource_mismatch"]},{"u":"https://intel.twzrd.xyz/v1/intel/quick/:solana_address","m":"GET","c":["resource_mismatch"]}];
  const t = (ms) => AbortSignal.timeout(ms);
  for (const c of cands) {
    const line = { url: c.u, codes: c.c };
    try {
      const r = await fetch(c.u, { method: c.m, headers: c.m === "GET" ? {} : { "content-type": "application/json" }, body: c.m === "GET" ? undefined : "{}", signal: t(15000) });
      line.status = r.status;
      const h = r.headers.get("payment-required");
      let ch = null;
      if (h) try { ch = JSON.parse(Buffer.from(h, "base64").toString()); } catch {}
      const body = await r.text();
      if (!ch) try { const b = JSON.parse(body); if (b.accepts) ch = b; } catch {}
      if (ch) line.ch = { v: ch.x402Version, resource: ch.resource?.url ?? ch.accepts?.[0]?.resource, accepts: (ch.accepts || []).map((a) => [a.network, a.asset, a.amount ?? a.maxAmountRequired, a.scheme].join(" ")) };
      else line.body = body.slice(0, 200);
    } catch (e) { line.err = e.message; }
    const origin = new URL(c.u).origin;
    const hints = new Set();
    for (const p of ["/", "/openapi.json", "/.well-known/x402"]) {
      try {
        const r = await fetch(origin + p, { signal: t(10000) });
        const s = (await r.text()).slice(0, 300000);
        for (const m of s.matchAll(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g)) if (!/\.(png|jpg|svg|webp|js|css)$/i.test(m[0]) && !/example|sentry|w3\.org|schema/i.test(m[0])) hints.add(m[0]);
        for (const m of s.matchAll(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|github\.com|t\.me|discord\.gg)\/[\w./-]+/g)) hints.add(m[0]);
      } catch {}
    }
    line.contact = [...hints].slice(0, 8);
    console.log("CAND " + JSON.stringify(line));
  }
}
