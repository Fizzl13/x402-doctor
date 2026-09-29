// Read-only: how Google would see fizzl.eu (status, redirects, robots headers, title).
const urls = ['https://fizzl.eu/', 'http://fizzl.eu/', 'https://www.fizzl.eu/', 'http://www.fizzl.eu/', 'https://fizzl.eu/robots.txt', 'https://fizzl.eu/sitemap.xml', 'https://fizzl.eu/index.html'];
const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
for (const u of urls) {
  try {
    const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    const body = r.status < 300 ? await r.text() : '';
    const title = (body.match(/<title>([^<]*)/) || [])[1];
    const robots = (body.match(/<meta name="robots" content="([^"]*)/) || [])[1];
    console.log('SEO', u, r.status, 'loc=' + (r.headers.get('location') || '-'), 'xrobots=' + (r.headers.get('x-robots-tag') || '-'), 'type=' + r.headers.get('content-type'), 'len=' + body.length, title ? 'title=' + title : '', robots ? 'robots=' + robots : '', u.endsWith('.txt') || u.endsWith('.xml') ? '\n' + body.slice(0, 300) : '');
  } catch (e) { console.log('SEO', u, 'ERR', e.message); }
}
for (const q of ['fizzl.eu']) {
  try { const r = await fetch('https://dns.google/resolve?name=' + q + '&type=A'); console.log('DNS', JSON.stringify((await r.json()).Answer)); } catch (e) { console.log('DNS ERR', e.message); }
}
