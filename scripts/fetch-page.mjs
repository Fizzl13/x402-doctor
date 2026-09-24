// One-off: read Xona's Linktree, then the non-social sites it links to, and
// look for x402 endpoints (/.well-known/x402, /openapi.json, 402 answers).
const UA = { 'user-agent': 'Mozilla/5.0 (research; x402-doctor)' };
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;|&\w+;/g, ' ').replace(/\s+/g, ' ').trim();
const SOCIAL = /(x\.com|twitter\.com|t\.me|telegram|discord|youtube|instagram|tiktok|linkedin|medium\.com|linktr\.ee|apple\.com|google\.com|facebook)/i;

const res = await fetch('https://linktr.ee/xona_agent', { headers: UA });
const html = await res.text();
console.log(`linktree HTTP ${res.status}`);
const next = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
let links = [];
if (next) {
  const data = JSON.parse(next[1]);
  const acct = data?.props?.pageProps?.account || {};
  console.log(`profile: ${acct.pageTitle || ''} | ${acct.description || ''}`);
  links = (data?.props?.pageProps?.links || acct.links || []).map((l) => ({ title: l.title, url: l.url }));
  const socials = (acct.socialLinks || []).map((s) => s.url);
  console.log(`socials: ${socials.join(' ')}`);
}
if (!links.length) links = [...new Set([...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]))].map((url) => ({ title: '', url }));
for (const l of links) console.log(`LINK ${l.title} -> ${l.url}`);

const origins = new Set();
for (const l of links) {
  if (!l.url || SOCIAL.test(l.url)) continue;
  try {
    const r = await fetch(l.url, { headers: UA, redirect: 'follow' });
    const h = await r.text();
    const u = new URL(r.url);
    origins.add(u.origin);
    console.log(`\n===== ${l.url} -> ${r.url} (HTTP ${r.status})\n${text(h).slice(0, 2500)}`);
    const more = [...new Set([...h.matchAll(/href="([^"#]+)"/g)].map((m) => { try { return new URL(m[1], r.url).href; } catch { return null; } }).filter(Boolean))];
    console.log(`-- links: ${more.filter((x) => !SOCIAL.test(x)).slice(0, 50).join(' ')}`);
    for (const m of more) { try { const o = new URL(m); if (/xona/i.test(o.host)) origins.add(o.origin); } catch {} }
  } catch (e) { console.log(`${l.url}: ${e.message}`); }
}

console.log(`\n## origins to probe: ${[...origins].join(' ')}`);
for (const o of origins) {
  for (const p of ['/.well-known/x402', '/openapi.json', '/api', '/llms.txt']) {
    try {
      const r = await fetch(o + p, { headers: UA });
      const body = await r.text();
      console.log(`\n-- ${o}${p}: HTTP ${r.status} ${r.headers.get('content-type') || ''} ${r.headers.get('payment-required') ? '[payment-required header]' : ''}\n${body.slice(0, 1500)}`);
    } catch (e) { console.log(`${o}${p}: ${e.message}`); }
  }
}
