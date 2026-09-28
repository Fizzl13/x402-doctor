// Eight Coinbase-listed aggregators: are we in them, and how does a provider get listed (form, API, email)?
const OURS = /x402-doctor|presign-guard|ichimoku-signal|smartcontractexplainer/i;
const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html,application/json,text/plain' };
const get = async (u, opt = {}) => { try { const r = await fetch(u, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(15000), ...opt }); return { status: r.status, url: r.url, body: await r.text() }; } catch (e) { return { status: 0, url: u, body: String(e.message) }; } };
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const sites = {
  EntRoute: 'https://entroute.com', Rencom: 'https://x402.rencom.ai', Fluora: 'https://www.fluora.ai', Agoragentic: 'https://agoragentic.com',
  AIsa: 'https://aisa.one', Dexter: 'https://dexter.cash', RelAI: 'https://relai.fi', 'Oops!402': 'https://oops402.com',
};
for (const [name, base] of Object.entries(sites)) {
  const home = await get(base);
  const t = text(home.body);
  const links = [...new Set([...home.body.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]))];
  const rel = links.filter((x) => /submit|register|provider|seller|sell|list|publish|onboard|add|docs|api|llms|developer|contact|mailto|github/i.test(x)).slice(0, 18);
  console.log(`\n######## ${name} ${base} -> ${home.status} ${home.url}\n  ${t.slice(0, 350)}\n  ours on home: ${OURS.test(home.body)}\n  links: ${rel.join(' | ')}`);
  // llms.txt / openapi often name the register endpoint
  for (const p of ['/llms.txt', '/openapi.json', '/.well-known/x402']) {
    const r = await get(base.replace(/\/$/, '') + p);
    if (r.status !== 200 || r.body.length < 20 || /<html/i.test(r.body.slice(0, 200))) continue;
    const lines = r.body.split('\n').filter((l) => /regist|submit|provider|seller|list your|add your|onboard|index|search|discover/i.test(l)).slice(0, 12);
    console.log(`  ${p} (${r.body.length} bytes): ${lines.map((l) => l.trim().slice(0, 200)).join('\n    ')}`);
    if (p === '/openapi.json') { try { const j = JSON.parse(r.body); console.log('  openapi paths:', Object.keys(j.paths || {}).filter((x) => /regist|submit|provider|seller|list|search|discover|endpoint/i.test(x)).join(' ')); } catch {} }
  }
  // search for us, where a search API is guessable
  for (const q of [`/api/search?q=presign`, `/search?q=presign-guard`, `/api/v1/search?q=presign`]) {
    const r = await get(base.replace(/\/$/, '') + q);
    if (r.status === 200) { console.log(`  search ${q}: ours=${OURS.test(r.body)} ${text(r.body).slice(0, 160)}`); break; }
  }
}
