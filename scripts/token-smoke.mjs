// Fetch the subdomain sites' own files (read-only GETs) and print them gzipped + base64. Output is data only.
import { gzipSync } from 'node:zlib';
const SITES = ['ai', 'cv', 'lab', 'projects'];
for (const s of SITES) {
  const base = `https://${s}.fizzl.eu/`;
  const html = await (await fetch(base, { signal: AbortSignal.timeout(30000) })).text();
  const refs = new Set(['index.html']);
  for (const m of html.matchAll(/(?:href|src|poster)="([^"#?]+)"/gi)) { const u = m[1]; if (!/^(https?:|mailto:|\/\/|data:)/.test(u)) refs.add(u.replace(/^\.?\//, '')); }
  console.log(`LIST ${s} ${[...refs].join(' ')}`);
  for (const f of refs) {
    try {
      const r = await fetch(base + (f === 'index.html' ? '' : f), { signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 400000) { console.log(`SKIP ${s}/${f} ${r.status} ${buf.length}b (large, left on the server)`); continue; }
      const z = gzipSync(buf).toString('base64');
      console.log(`FILE ${s}/${f} ${r.status} ${buf.length}b`);
      for (let i = 0; i < z.length; i += 8000) console.log(`B64 ${s}/${f} ${z.slice(i, i + 8000)}`);
    } catch (e) { console.log(`ERR ${s}/${f} ${e.message}`); }
  }
}
