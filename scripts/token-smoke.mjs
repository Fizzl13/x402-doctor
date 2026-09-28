// Public Glama pages for our servers.
const ua = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36', accept: 'text/html' };
const urls = [
  'https://glama.ai/mcp/servers?query=fizzl13',
  'https://glama.ai/mcp/connectors?query=fizzl',
  'https://glama.ai/mcp/servers/@Fizzl13/x402-doctor',
  'https://glama.ai/mcp/servers/@Fizzl13/presign-guard',
  'https://glama.ai/mcp/servers/@Fizzl13/ichimoku-signal',
  'https://glama.ai/mcp/servers/@Fizzl13/SmartContractExplainer',
];
for (const u of urls) {
  const r = await fetch(u, { headers: ua, redirect: 'follow' });
  const t = await r.text();
  console.log('==', u, r.status, '->', r.url, t.length);
  console.log(' links:', [...new Set(t.match(/\/mcp\/(servers|connectors)\/[A-Za-z0-9@_.\/-]*(fizzl|Fizzl|x402-doctor|presign|ichimoku|SmartContract|plaintext)[A-Za-z0-9_.\/-]*/g) || [])].slice(0, 15).join(' '));
  console.log(' hosts:', [...new Set(t.match(/https?:\/\/[a-z0-9.-]*(fizzl\.eu|onrender\.com)[^"'<\s\\]*/g) || [])].slice(0, 10).join(' '));
}
