// What EntRoute's POST /submit, Fluora's /submit and Dexter's indexter.cash need from a provider.
const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html,application/json,text/plain' };
const get = async (u) => { try { const r = await fetch(u, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(15000) }); return { status: r.status, url: r.url, body: await r.text() }; } catch (e) { return { status: 0, url: u, body: String(e.message) }; } };
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const around = (t, re, before = 200, after = 2500) => { const i = t.search(re); return i < 0 ? '(not found)' : t.slice(Math.max(0, i - before), i + after); };
// EntRoute
for (const u of ['https://entroute.com/docs/api', 'https://entroute.com/llms-full.txt', 'https://entroute.com/docs/providers', 'https://entroute.com/docs/submit']) {
  const r = await get(u);
  console.log(`\n==== ${u} ${r.status}\n${around(/<html/i.test(r.body.slice(0, 300)) ? text(r.body) : r.body, /POST \/submit|\/submit/i)}`);
}
const prov = await get('https://entroute.com/providers');
console.log('\nentroute providers ours:', /x402-doctor|presign-guard|ichimoku|smartcontractexplainer/i.test(prov.body));
// Fluora
const fl = await get('https://www.fluora.ai/submit');
console.log(`\n==== fluora /submit ${fl.status}\n${text(fl.body).slice(0, 2500)}`);
console.log('fluora inputs:', [...fl.body.matchAll(/<(input|textarea|select)[^>]*name="([^"]+)"[^>]*>/g)].map((m) => m[2]).join(', '));
// Dexter / indexter
for (const u of ['https://indexter.cash', 'https://indexter.cash/llms.txt', 'https://docs.dexter.cash/docs']) {
  const r = await get(u);
  const t = /<html/i.test(r.body.slice(0, 300)) ? text(r.body) : r.body;
  console.log(`\n==== ${u} ${r.status}\n${t.slice(0, 900)}\n  ...submit/list: ${around(t, /submit|list your|add your|register|provider/i, 100, 700)}`);
}
