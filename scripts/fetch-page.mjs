// One-off: pg1 /api/mcp: a real tools/call without payment, and CORS on /api/ioc.
const call = (name, args, extra = {}) => fetch('https://pg1-ai-agent.vercel.app/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
for (const [label, res] of [
  ['tools/call get_cve_details, no payment', await call('get_cve_details', { cve_id: 'CVE-2021-44228' })],
  ['tools/call get_cve_details, x-free-tier: 1', await call('get_cve_details', { cve_id: 'CVE-2021-44228' }, { 'x-free-tier': '1' })],
  ['tools/call get_usage_status (free tool)', await call('get_usage_status', {})],
]) {
  const pr = res.headers.get('payment-required');
  let decoded = '';
  if (pr) { try { const c = JSON.parse(Buffer.from(pr, 'base64').toString()); decoded = JSON.stringify({ v: c.x402Version, accepts: c.accepts, resource: c.resource }).slice(0, 600); } catch { decoded = 'undecodable'; } }
  console.log(`\n--- ${label}: HTTP ${res.status}\nPAYMENT-REQUIRED: ${decoded || '(none)'}\nexpose: ${res.headers.get('access-control-expose-headers')}\nbody: ${(await res.text()).slice(0, 400)}`);
}
const o = await fetch('https://pg1-ai-agent.vercel.app/api/ioc', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'payment-signature' } });
console.log(`\nOPTIONS /api/ioc: ${o.status} allow-headers: ${o.headers.get('access-control-allow-headers')} expose: ${o.headers.get('access-control-expose-headers')}`);
