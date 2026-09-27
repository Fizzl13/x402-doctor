// Which aggregators / discovery services does Coinbase (CDP docs, x402 repos) name as partners?
const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', accept: 'text/html,application/json,text/plain' };
const get = async (u) => { try { const r = await fetch(u, { headers: ua, redirect: 'follow', signal: AbortSignal.timeout(15000) }); return { status: r.status, url: r.url, body: await r.text() }; } catch (e) { return { status: 0, url: u, body: String(e.message) }; } };
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
// 1) CDP docs index
const llms = await get('https://docs.cdp.coinbase.com/llms.txt');
console.log('CDP llms', llms.status);
for (const l of llms.body.split('\n').filter((x) => /x402|bazaar|discover|ecosystem|partner|marketplace|agentic/i.test(x)).slice(0, 40)) console.log('  ', l.slice(0, 220));
for (const p of ['https://docs.cdp.coinbase.com/x402/bazaar', 'https://docs.cdp.coinbase.com/x402/ecosystem', 'https://docs.cdp.coinbase.com/x402/welcome']) {
  const r = await get(p);
  const t = text(r.body);
  const hits = [...new Set((r.body.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map((u) => u.toLowerCase()).filter((u) => !/coinbase|cdp|mintlify|googleapis|gstatic|w3\.org|schema\.org|github\.com\/coinbase/.test(u)))];
  console.log(`\n== ${p} ${r.status}\n${t.slice(0, 700)}\n  external hosts: ${hits.slice(0, 40).join(' ')}`);
}
// 2) x402 repos: ecosystem / partners data
for (const repo of ['coinbase/x402', 'x402-foundation/x402']) {
  const tree = await get(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`);
  let paths = [];
  try { paths = JSON.parse(tree.body).tree.map((t) => t.path); } catch {}
  const eco = paths.filter((p) => /ecosystem|partner/i.test(p) && !/node_modules/.test(p));
  console.log(`\n== ${repo}: ${paths.length} files, ecosystem/partner paths: ${eco.length}`);
  const cats = {};
  for (const p of eco) { const m = p.match(/partners-data\/([^/]+)\//); if (m) cats[m[1]] = 1; }
  console.log('  partner entries:', Object.keys(cats).length);
  const meta = eco.filter((p) => /metadata\.json$/.test(p));
  const out = [];
  for (const m of meta.slice(0, 400)) {
    const r = await get(`https://raw.githubusercontent.com/${repo}/main/${m}`);
    try { const j = JSON.parse(r.body); out.push({ name: j.name, cat: j.category, url: j.websiteUrl || j.url, desc: (j.description || '').slice(0, 110) }); } catch {}
  }
  const agg = out.filter((o) => /discover|directory|marketplace|index|catalog|search|registry|aggregat|explorer|bazaar|router|store|hub|list/i.test(`${o.name} ${o.cat} ${o.desc}`));
  console.log(`  categories: ${[...new Set(out.map((o) => o.cat))].join(' | ')}`);
  console.log(`  aggregator-like (${agg.length} of ${out.length}):`);
  for (const o of agg) console.log(`   - ${o.name} [${o.cat}] ${o.url} :: ${o.desc}`);
  if (meta.length) break;
}
