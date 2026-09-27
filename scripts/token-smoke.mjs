// Find Orthogonal's site and how providers get listed.
const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html' };
const html = await (await fetch('https://www.linkedin.com/pulse/what-onboarding-700-x402-enabled-api-endpoints-teaching-pickett-vciec', { headers: ua })).text();
const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, '&'))).map((u) => { const m = u.match(/[?&]url=([^&]+)/); return m ? decodeURIComponent(m[1]) : u; });
console.log('LINKS', [...new Set(links.filter((u) => /orthogonal|orth|pickett/i.test(u)))].slice(0, 30).join('\n'));
const author = html.match(/"author"[\s\S]{0,300}/);
console.log('AUTHOR', author && author[0].replace(/\s+/g, ' ').slice(0, 300));
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
for (const u of ['https://orthogonal.com', 'https://www.orthogonal.com', 'https://orth.sh', 'https://orthogonal.sh', 'https://getorthogonal.com', 'https://orthogonal.ai']) {
  try {
    const r = await fetch(u, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const h = await r.text();
    const t = text(h);
    console.log(`\n== ${u} -> ${r.status} ${r.url}\n${t.slice(0, 900)}`);
    const l2 = [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((x) => /provider|partner|list|contact|docs|mailto|seller|onboard|apply|x402/i.test(x));
    console.log('RELEVANT LINKS', [...new Set(l2)].slice(0, 25).join(' | '));
  } catch (e) { console.log(`== ${u} ERR ${e.message}`); }
}
