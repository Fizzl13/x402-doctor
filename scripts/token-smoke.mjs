// Where do fizzl.eu and its subdomains point? (before moving the main site)
import { Resolver } from 'node:dns/promises';
const r = new Resolver(); r.setServers(['8.8.8.8']);
const q = async (fn, h) => { try { return JSON.stringify(await r[fn](h)); } catch (e) { return e.code; } };
for (const h of ['fizzl.eu', 'www.fizzl.eu', 'ai.fizzl.eu', 'cv.fizzl.eu', 'lab.fizzl.eu', 'projects.fizzl.eu']) {
  console.log(h, 'CNAME', await q('resolveCname', h), 'A', await q('resolve4', h));
}
console.log('MX', await q('resolveMx', 'fizzl.eu'));
console.log('TXT', await q('resolveTxt', 'fizzl.eu'));
for (const h of ['ai', 'cv', 'lab', 'projects']) {
  try { const x = await fetch(`https://${h}.fizzl.eu/`, { redirect: 'manual' }); const b = await x.text(); console.log(h, x.status, x.headers.get('server'), x.headers.get('location') || '', (b.match(/<title>[^<]*<\/title>/) || [''])[0]); } catch (e) { console.log(h, 'ERR', e.cause?.code || e.message); }
}
