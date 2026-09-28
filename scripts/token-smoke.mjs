// Check the EntRoute TXT records and submission status.
import { Resolver } from 'node:dns/promises';
const subs = {
  'x402-doctor': '16625e28-6c96-446e-8610-ddbf7c3b7b2e',
  'presign-guard': '4bcddc6c-3c0d-42e8-833a-1cbb1badc08b',
  'ichimoku-signal': '79b6aca8-d398-4500-87ff-0e7f863e8496',
};
for (const ns of [['8.8.8.8'], ['1.1.1.1']]) {
  const r = new Resolver(); r.setServers(ns);
  for (const h of Object.keys(subs)) {
    try { console.log(ns[0], `_entroute.${h}.fizzl.eu`, JSON.stringify(await r.resolveTxt(`_entroute.${h}.fizzl.eu`))); }
    catch (e) { console.log(ns[0], `_entroute.${h}.fizzl.eu`, 'ERR', e.code); }
  }
  try { console.log(ns[0], 'fizzl.eu', JSON.stringify(await r.resolveTxt('fizzl.eu'))); } catch (e) { console.log('fizzl.eu ERR', e.code); }
}
// Authoritative Strato nameservers
const { resolveNs, resolve4 } = await import('node:dns/promises');
try {
  const nss = await resolveNs('fizzl.eu'); console.log('NS', nss.join(','));
  const ip = (await resolve4(nss[0]))[0]; const r = new Resolver(); r.setServers([ip]);
  for (const h of Object.keys(subs)) {
    try { console.log('auth', h, JSON.stringify(await r.resolveTxt(`_entroute.${h}.fizzl.eu`))); } catch (e) { console.log('auth', h, 'ERR', e.code); }
  }
} catch (e) { console.log('auth ERR', e.message); }
for (const [h, id] of Object.entries(subs)) {
  const r = await fetch(`https://api.entroute.com/submit/${id}`, { headers: { accept: 'application/json' } });
  console.log('status', h, r.status, (await r.text()).slice(0, 600));
}
