// One-off: are the Fizzl services listed on Agentic.Market, x402scan, Glama, Smithery, mcp.so? (read-only)
const pages = [
  'https://agentic.market/services/ichimoku-signal-onrender-com',
  'https://agentic.market/services/x402-doctor-onrender-com',
  'https://agentic.market/services/presign-guard-onrender-com',
  'https://agentic.market/about',
  'https://www.x402scan.com/resources/register',
  'https://glama.ai/mcp/connectors/io.github.Fizzl13/ichimoku-signal',
  'https://smithery.ai/search?q=ichimoku',
  'https://mcp.so/search?q=ichimoku',
];
for (const url of pages) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }, redirect: 'follow' });
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const title = (html.match(/<title>([^<]*)/) || [])[1];
    const hits = ['ichimoku', 'fizzl', 'x402 doctor', 'presign', 'list your', 'submit', 'add your', 'provider'].map((w) => [w, (text.toLowerCase().split(w).length - 1)]).filter(([, n]) => n);
    console.log(`\n${r.status} ${url}\n  title: ${title}\n  hits: ${JSON.stringify(hits)}`);
    if (url.includes('/about') || url.includes('agentic.market/services')) console.log('  text:', text.slice(0, 1500));
  } catch (e) { console.log(`\nERR ${url} ${e.message}`); }
}
