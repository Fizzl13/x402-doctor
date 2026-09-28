// Live check after the brand v2 + link preview merges: og tags, og image, logo B and mint on all four services.
const S = { 'https://ichimoku-signal.fizzl.eu': '/media/og.jpg', 'https://x402-doctor.fizzl.eu': '/og.jpg', 'https://presign-guard.fizzl.eu': '/media/og.jpg', 'https://plaintext.fizzl.eu': '/og.jpg' };
const done = {};
for (let round = 0; round < 30 && Object.keys(done).length < 4; round++) {
  for (const [host, img] of Object.entries(S)) {
    if (done[host]) continue;
    try {
      const html = await (await fetch(host + '/', { headers: { accept: 'text/html' } })).text();
      const og = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
      if (!og) { if (round % 5 === 0) console.log(new Date().toISOString(), host, 'no og:image yet'); continue; }
      const r = await fetch(og);
      const buf = Buffer.from(await r.arrayBuffer());
      done[host] = `og ${og} -> ${r.status} ${r.headers.get('content-type')} ${buf.length}B; mint ${html.includes('#61f5c3')}; violet ${html.includes('a78bfa')}; fonts ${html.includes('Space+Grotesk')}; title ${(html.match(/og:title" content="([^"]+)/) || [])[1]}`;
      console.log(new Date().toISOString(), host, done[host]);
    } catch (e) { console.log(host, 'ERR', e.message); }
  }
  if (Object.keys(done).length < 4) await new Promise((s) => setTimeout(s, 20000));
}
console.log('summary', Object.keys(done).length, 'of 4');
