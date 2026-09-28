// Copy the fizzl.eu site files into the log (gzip + base64), so they can be versioned.
import { gzipSync } from 'node:zlib';
for (const f of ['index.html', 'style.css', 'script.js', 'digital-twin.js', 'process-agent.js', 'favicon.ico', 'robots.txt', 'sitemap.xml']) {
  const r = await fetch('https://fizzl.eu/' + f);
  if (!r.ok) { console.log(`FILE ${f} HTTP ${r.status}`); continue; }
  const buf = Buffer.from(await r.arrayBuffer());
  const b64 = gzipSync(buf).toString('base64');
  console.log(`FILE ${f} ${buf.length} ${b64.length}`);
  for (let i = 0; i < b64.length; i += 2000) console.log(`B64 ${f} ${b64.slice(i, i + 2000)}`);
}
const h = await (await fetch('https://fizzl.eu/')).text();
console.log('REFS', [...new Set([...h.matchAll(/(?:src|href)="(?!https?:|mailto:|#)([^"]+)"/g)].map((m) => m[1]))].join(' '));
