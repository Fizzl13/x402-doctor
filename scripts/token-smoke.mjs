// presign-guard: why did PG1's sanctions screen come back unavailable? Nothing paid.
const PG1 = 'https://pg1-ai-agent.vercel.app/api/mcp';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
let id = 0;
async function call(name, args) {
  const t0 = Date.now();
  try {
    const r = await fetch(PG1, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    const ms = Date.now() - t0;
    const sse = text.match(/^data: (.*)$/m);
    let body = null; try { body = JSON.parse(sse ? sse[1] : text); } catch {}
    const res = body?.result;
    const out = res?.structuredContent ?? (() => { try { return JSON.parse(res?.content?.[0]?.text ?? 'null'); } catch { return res?.content?.[0]?.text?.slice(0, 200); } })();
    console.log(`${name} ${args.address ?? ''} → HTTP ${r.status} ${ms}ms${ms > 3000 ? ' (OVER 3 s timeout)' : ''} isError=${!!res?.isError} ratelimit-remaining=${r.headers.get('x-ratelimit-remaining')}`);
    console.log('   ', JSON.stringify(out ?? body?.error ?? text.slice(0, 200)).slice(0, 400));
  } catch (e) { console.log(`${name} → FAILED after ${Date.now() - t0}ms: ${e.message}`); }
}
const h = await fetch('https://presign-guard.onrender.com/health', { signal: AbortSignal.timeout(60000) }).then((r) => r.json()).catch((e) => ({ err: e.message }));
console.log('presign-guard /health:', JSON.stringify(h));
for (let i = 0; i < 3; i++) await call('check_wallet_sanctions', { address: PERMIT2 });
await new Promise((r) => setTimeout(r, 20000));
console.log('after 20 s:');
await call('check_wallet_sanctions', { address: PERMIT2 });
