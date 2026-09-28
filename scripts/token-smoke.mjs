// Research: what scvd.store offers (read-only GETs, no payment). Output is data only.
const base = 'https://scvd.store';
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;/g, ' ').replace(/\s+/g, ' ');
for (const p of ['/', '/.well-known/x402', '/openapi.json', '/llms.txt', '/robots.txt', '/docs', '/pricing', '/api', '/mcp']) {
  try {
    const res = await fetch(base + p, { headers: { accept: p === '/' || p === '/docs' || p === '/pricing' ? 'text/html' : 'application/json, text/plain, */*', 'user-agent': 'Mozilla/5.0 research' }, redirect: 'follow' });
    const t = await res.text();
    const ct = res.headers.get('content-type') || '';
    console.log(`\n## ${p} -> ${res.status} ${ct} ${t.length}b`);
    console.log((ct.includes('html') ? strip(t) : t).slice(0, p === '/openapi.json' ? 9000 : 3500));
  } catch (e) { console.log(`${p}: ${e.message}`); }
}
