// EntRoute: capability ids, and the full /submit docs (what verification looks like).
const r = await fetch('https://entroute.com/capabilities', { headers: { accept: 'application/json' } });
const t = await r.text();
let caps = null; try { caps = JSON.parse(t); } catch {}
if (caps) console.log('CAPS JSON', JSON.stringify(caps).slice(0, 6000));
else console.log('CAPS HTML ids:', [...new Set(t.match(/\b[a-z]+\.[a-z_]+\b/g) || [])].filter((x) => !/\.(com|js|css|png|svg|io|dev|ai|org|net)$/.test(x)).join(' ').slice(0, 4000));
for (const u of ['https://api.entroute.com/capabilities', 'https://entroute.com/api/capabilities']) {
  try { const x = await fetch(u, { headers: { accept: 'application/json' } }); console.log('\n', u, x.status, (await x.text()).slice(0, 3000)); } catch (e) { console.log(u, e.message); }
}
const docs = await (await fetch('https://entroute.com/docs/api')).text();
const plain = docs.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#[0-9]+;/g, '').replace(/\s+/g, ' ');
const i = plain.indexOf('base URL'); console.log('\nBASE', plain.match(/https:\/\/api\.entroute\.com[^ ]*|base url[^.]*\./i));
const j = plain.indexOf('POST /submit'); console.log('\nSUBMIT DOCS', plain.slice(j - 100, j + 1800));
