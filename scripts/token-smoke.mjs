// What does fizzl.eu serve today, and can a page on fizzl.eu call the free endpoints (CORS)?
import { Resolver } from 'node:dns/promises';
const r = new Resolver(); r.setServers(['8.8.8.8']);
for (const [h, t] of [['fizzl.eu', 'A'], ['www.fizzl.eu', 'A'], ['www.fizzl.eu', 'CNAME'], ['fizzl.eu', 'AAAA']]) {
  try { console.log('dns', h, t, JSON.stringify(t === 'A' ? await r.resolve4(h) : t === 'AAAA' ? await r.resolve6(h) : await r.resolveCname(h))); } catch (e) { console.log('dns', h, t, e.code); }
}
for (const u of ['https://fizzl.eu/', 'http://fizzl.eu/', 'https://www.fizzl.eu/']) {
  try { const x = await fetch(u, { redirect: 'manual' }); const b = await x.text(); console.log('==', u, x.status, x.headers.get('location'), x.headers.get('server'), (b.match(/<title>[^<]*<\/title>/) || [''])[0], b.length); } catch (e) { console.log('==', u, 'ERR', e.cause?.code || e.message); }
}
const O = { origin: 'https://fizzl.eu' };
for (const u of ['https://ichimoku-signal.fizzl.eu/api/trend/BTC-USDT', 'https://ichimoku-signal.fizzl.eu/setups/preview', 'https://x402-doctor.fizzl.eu/api/quick?url=https%3A%2F%2Fichimoku-signal.fizzl.eu%2Fsignal%2FBTC-USDT', 'https://x402-doctor.fizzl.eu/', 'https://presign-guard.fizzl.eu/', 'https://plaintext.fizzl.eu/']) {
  try { const x = await fetch(u, { headers: { ...O, accept: 'application/json' } }); console.log('cors', u, x.status, 'ACAO=', x.headers.get('access-control-allow-origin'), (await x.text()).slice(0, 160).replace(/\s+/g, ' ')); } catch (e) { console.log('cors', u, 'ERR', e.message); }
}
