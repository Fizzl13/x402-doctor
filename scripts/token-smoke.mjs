// Research: what is vishwalab.com? Home page text, links, and common agent/x402 discovery files.
const base = 'https://vishwalab.com';
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
async function get(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (research)', accept: 'text/html,application/json,*/*' } });
    return { status: r.status, url: r.url, type: r.headers.get('content-type') || '', text: await r.text() };
  } catch (e) { return { status: 'ERR', text: e.cause?.code || e.message }; }
}
const home = await get(base);
console.log('HOME', home.status, home.url, home.type, home.text.length);
console.log('TITLE', (home.text.match(/<title>([^<]*)/i) || [])[1]);
console.log('META', [...home.text.matchAll(/<meta[^>]+(?:name|property)="(description|og:description|og:title)"[^>]+content="([^"]*)"/gi)].map((m) => `${m[1]}=${m[2]}`).join(' | '));
const text = strip(home.text);
for (let i = 0; i < Math.min(text.length, 6000); i += 1500) console.log('TEXT', text.slice(i, i + 1500));
const links = [...new Set([...home.text.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]))].filter((l) => !/\.(css|png|jpg|svg|ico|woff2?)(\?|$)/.test(l));
console.log('LINKS', links.slice(0, 60).join(' '));
// Next.js / SPA bundles: look for API hosts and x402 mentions in the first scripts.
const scripts = [...home.text.matchAll(/src="([^"]+\.js)"/g)].map((m) => new URL(m[1], home.url || base).href).slice(0, 8);
for (const s of scripts) {
  const js = await get(s);
  const hits = [...new Set((js.text.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'`\s)]{0,60}/gi) || []).filter((u) => !/w3\.org|schema\.org|reactjs|nextjs|github\.com\/facebook/.test(u)))].slice(0, 15);
  const words = ['x402', 'solana', 'mainnet', 'devnet', 'testnet', 'waitlist', 'audit', 'policy', 'vault', 'custody', 'token'].map((w) => `${w}:${(js.text.match(new RegExp(w, 'gi')) || []).length}`).join(' ');
  console.log('JS', s, js.text.length, words, hits.join(' '));
}
for (const p of ['/.well-known/x402', '/openapi.json', '/llms.txt', '/robots.txt', '/sitemap.xml', '/docs', '/api', '/.well-known/agent.json']) {
  const r = await get(base + p);
  console.log('PATH', p, r.status, r.type, strip(String(r.text)).slice(0, 400));
}
