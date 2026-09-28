// Research: where do the onrender URLs of the fizzl services come from? Output is data only.
const NAMES = /ichimoku-signal|presign-guard|x402-doctor|plaintext|smartcontractexplainer|fizzl/i;
const log = (...a) => console.log(...a);

// 1. CDP Bazaar catalogue
try {
  const items = [];
  for (let offset = 0; offset < 60000; offset += 500) {
    const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
    if (!res.ok) { log(`CDP HTTP ${res.status} at ${offset}`); break; }
    const page = (await res.json()).items || [];
    items.push(...page);
    if (page.length < 500) break;
  }
  log(`## Bazaar: ${items.length} resources`);
  for (const it of items) {
    if (!NAMES.test(it.resource || '')) continue;
    const a = it.accepts?.[0] || {};
    log(`BAZAAR ${it.resource} | lastUpdated ${it.lastUpdated} | ${a.network} | payTo ${String(a.payTo).slice(0, 8)} | accepts ${it.accepts?.length}`);
  }
} catch (e) { log(`bazaar: ${e.message}`); }

// 2. our own 402 challenge and discovery doc on each host
const HOSTS = ['ichimoku-signal.fizzl.eu', 'ichimoku-signal.onrender.com', 'presign-guard.fizzl.eu', 'presign-guard.onrender.com', 'x402-doctor.fizzl.eu', 'x402-doctor.onrender.com', 'plaintext.fizzl.eu', 'smartcontractexplainer.onrender.com'];
const PATHS = { 'ichimoku-signal': '/signal/BTC-USDT', 'presign-guard': '/v1/token?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'x402-doctor': '/api/v1/diagnose?url=https://example.com', plaintext: '/api/check-wallet?address=0x0000000000000000000000000000000000000001', smartcontractexplainer: '/api/check-wallet?address=0x0000000000000000000000000000000000000001' };
for (const h of HOSTS) {
  const key = Object.keys(PATHS).find((k) => h.startsWith(k));
  for (const p of ['/.well-known/x402', PATHS[key]]) {
    try {
      const res = await fetch(`https://${h}${p}`, { redirect: 'manual', headers: { accept: 'application/json' } });
      let info = `${res.status}`;
      if (res.status >= 300 && res.status < 400) info += ` -> ${res.headers.get('location')}`;
      const pr = res.headers.get('payment-required');
      if (pr) { try { const j = JSON.parse(Buffer.from(pr, 'base64').toString()); info += ` resource.url=${j.resource?.url}`; } catch { info += ' (payment-required unreadable)'; } }
      if (res.status === 200 && p.startsWith('/.well')) { const t = await res.text(); info += ` ${t.slice(0, 400).replace(/\s+/g, ' ')}`; }
      else if (res.status === 402 && !pr) { const t = await res.text(); const m = t.match(/"resource"\s*:\s*"([^"]+)"/) || t.match(/"url"\s*:\s*"([^"]+)"/); info += ` body resource=${m?.[1]}`; }
      log(`HOST ${h}${p.slice(0, 40)} => ${info}`);
    } catch (e) { log(`HOST ${h}${p} => ERR ${e.message}`); }
  }
}

// 3. nsgoods: search by name fragments
async function mcp(method, params, sid) {
  const res = await fetch('https://mcp.nsgoods.org/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }) });
  const t = await res.text();
  const line = t.split('\n').find((l) => l.startsWith('data:'));
  return { sid: res.headers.get('mcp-session-id'), body: JSON.parse(line ? line.slice(5) : t) };
}
try {
  const { sid } = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fizzl-check', version: '1' } });
  await fetch('https://mcp.nsgoods.org/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  for (const q of ['fizzl', 'x402-doctor', 'plaintext', 'smartcontractexplainer', 'presign-guard', 'ichimoku']) {
    const r = await mcp('tools/call', { name: 'find_endpoints', arguments: { query: q, limit: 50 } }, sid);
    const txt = r.body.result?.content?.[0]?.text || JSON.stringify(r.body).slice(0, 300);
    let out = txt; try { const j = JSON.parse(txt); out = `total ${j.total ?? j.total_matches} :: ` + (j.endpoints || j.results || []).map((e) => `${e.resource || e.url} ${e.last_verdict || e.verdict}`).join(' | '); } catch {}
    log(`NSGOODS find ${q}: ${out.slice(0, 1500)}`);
  }
  const r = await mcp('tools/call', { name: 'catalogue_stats', arguments: {} }, sid);
  log(`NSGOODS stats: ${(r.body.result?.content?.[0]?.text || '').slice(0, 1200)}`);
} catch (e) { log(`nsgoods: ${e.message}`); }
