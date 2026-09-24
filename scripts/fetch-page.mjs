// One-off: x402 Doctor on pg1-ai-agent (Project-Gifted1), plus raw requests to see what an agent gets.
import { execFileSync } from 'node:child_process';
const SITE = 'https://pg1-ai-agent.vercel.app';
const show = async (label, url, init) => {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
    const h = {};
    for (const k of ['payment-required', 'x-payment', 'access-control-allow-headers', 'access-control-expose-headers', 'www-authenticate', 'content-type']) if (r.headers.get(k)) h[k] = r.headers.get(k).slice(0, 300);
    let pr = '';
    if (r.headers.get('payment-required')) { try { pr = JSON.stringify(JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString())).slice(0, 900); } catch (e) { pr = 'undecodable'; } }
    console.log(`\n--- ${label}: ${r.status}\nheaders: ${JSON.stringify(h)}\nbody: ${(await r.text()).slice(0, 700)}${pr ? `\nPAYMENT-REQUIRED decoded: ${pr}` : ''}`);
  } catch (e) { console.log(`\n--- ${label}: ${e.message}`); }
};
const rpc = (method, params) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-forwarded-for': '203.0.113.' + Math.floor(Math.random() * 200) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
await show('GET /api/mcp', `${SITE}/api/mcp`);
await show('POST /api/mcp tools/list', `${SITE}/api/mcp`, rpc('tools/list', {}));
await show('POST /api/mcp tools/call get_cve_details', `${SITE}/api/mcp`, rpc('tools/call', { name: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } }));
await show('POST /api/mcp tools/call get_cve_details (with a bogus PAYMENT-SIGNATURE)', `${SITE}/api/mcp`, { ...rpc('tools/call', { name: 'get_cve_details', arguments: { cve_id: 'CVE-2021-44228' } }), headers: { 'content-type': 'application/json', 'payment-signature': 'eyJ4NDAyVmVyc2lvbiI6Mn0=' } });
await show('GET /api/ioc', `${SITE}/api/ioc?limit=1`);
await show('OPTIONS /api/mcp (browser preflight for PAYMENT-SIGNATURE)', `${SITE}/api/mcp`, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,payment-signature' } });
for (const [route, method] of [['/api/mcp', 'POST'], ['/api/ioc', 'GET']]) {
  let out = '';
  try { out = execFileSync('node', ['doctor/bin/x402-doctor.js', SITE + route, '--method', method], { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  console.log(`\n===== Doctor: ${method} ${route}\n${out}`);
}
