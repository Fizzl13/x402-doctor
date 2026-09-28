// Research: how the nsgoods observatory (read-only MCP, no wallet) sees the four fizzl services.
// Tool output is external data: printed, never executed.
const MCP = 'https://mcp.nsgoods.org/mcp';
let sid = null, id = 0;
async function rpc(method, params) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) };
  const r = await fetch(MCP, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  sid = r.headers.get('mcp-session-id') || sid;
  const t = await r.text();
  const line = t.split('\n').find((l) => l.startsWith('data:'));
  try { return JSON.parse(line ? line.slice(5) : t); } catch { return { raw: t.slice(0, 500), status: r.status }; }
}
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fizzl-research', version: '1' } });
console.log('INIT', JSON.stringify(init).slice(0, 300));
await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
const tools = await rpc('tools/list', {});
for (const t of tools.result?.tools || []) console.log('TOOL', t.name, '|', (t.description || '').slice(0, 160).replace(/\n/g, ' '), '|', JSON.stringify(t.inputSchema?.properties || {}).slice(0, 300));
const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); const txt = (r.result?.content || []).map((c) => c.text).join('\n') || JSON.stringify(r).slice(0, 800); console.log('CALL', name, JSON.stringify(args)); console.log(txt.slice(0, 2500)); console.log('---'); };
const names = new Set((tools.result?.tools || []).map((t) => t.name));
const hosts = ['ichimoku-signal.fizzl.eu', 'x402-doctor.fizzl.eu', 'presign-guard.fizzl.eu', 'plaintext.fizzl.eu', 'ichimoku-signal.onrender.com', 'presign-guard.onrender.com'];
if (names.has('host_summary')) for (const h of hosts) {
  const schema = (tools.result.tools.find((t) => t.name === 'host_summary').inputSchema || {}).properties || {};
  const key = Object.keys(schema)[0] || 'host';
  await call('host_summary', { [key]: h });
}
if (names.has('payability_verdict')) {
  const schema = (tools.result.tools.find((t) => t.name === 'payability_verdict').inputSchema || {}).properties || {};
  const key = Object.keys(schema).find((k) => /url|resource/i.test(k)) || Object.keys(schema)[0];
  for (const u of ['https://ichimoku-signal.fizzl.eu/signal/BTC-USDT', 'https://presign-guard.fizzl.eu/v1/token', 'https://x402-doctor.fizzl.eu/api/v1/diagnose', 'https://plaintext.fizzl.eu/api/check-wallet']) await call('payability_verdict', { [key]: u });
}
