// Fetch the subdomain sites' own files (read-only GETs) into out/<site>/ for the import branch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
for (const s of ['ai', 'cv', 'lab', 'projects']) {
  const base = `https://${s}.fizzl.eu/`;
  const html = await (await fetch(base, { signal: AbortSignal.timeout(30000) })).text();
  const refs = new Set(['index.html']);
  for (const m of html.matchAll(/(?:href|src|poster)="([^"#?]+)"/gi)) { const u = m[1]; if (!/^(https?:|mailto:|tel:|\/\/|data:)/.test(u)) refs.add(u.replace(/^\.?\//, '')); }
  console.log(`LIST ${s} ${[...refs].join(' ')}`);
  for (const f of refs) {
    try {
      const r = await fetch(base + (f === 'index.html' ? '' : f), { signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok) { console.log(`MISS ${s}/${f} ${r.status}`); continue; }
      if (buf.length > 5000000) { console.log(`SKIP ${s}/${f} ${buf.length}b`); continue; }
      const p = `out/${s}/${f}`; mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf);
      console.log(`FILE ${s}/${f} ${buf.length}b`);
    } catch (e) { console.log(`ERR ${s}/${f} ${e.message}`); }
  }
}
