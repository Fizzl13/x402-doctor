// Orthogonal docs: is there a provider / seller onboarding route or a partner contact?
const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html,text/plain' };
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const get = async (u) => { try { const r = await fetch(u, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(12000) }); return { status: r.status, url: r.url, body: await r.text() }; } catch (e) { return { status: 0, body: e.message }; } };
// Mintlify-style docs usually publish llms.txt with every page.
for (const u of ['https://docs.orthogonal.com/llms.txt', 'https://docs.orthogonal.com/sitemap.xml']) {
  const r = await get(u);
  console.log(`== ${u} ${r.status}\n${r.body.slice(0, 4000)}`);
}
const home = await get('https://docs.orthogonal.com');
const links = [...new Set([...home.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];
console.log('\nDOC LINKS', links.filter((l) => !/\.(css|js|png|svg|ico|woff)/.test(l)).slice(0, 80).join(' | '));
for (const l of links.filter((x) => /provider|seller|partner|list|onboard|contact|support|monetiz|publish|sell/i.test(x)).slice(0, 6)) {
  const u = l.startsWith('http') ? l : `https://docs.orthogonal.com${l.startsWith('/') ? '' : '/'}${l}`;
  const r = await get(u);
  console.log(`\n== ${u} ${r.status}\n${text(r.body).slice(0, 2500)}`);
}
const site = await get('https://www.orthogonal.com');
console.log('\nMAILTO', [...new Set([...site.body.matchAll(/mailto:([^"?]+)/g)].map((m) => m[1]))].join(' '));
console.log('SITE LINKS', [...new Set([...site.body.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]))].slice(0, 60).join(' | '));
