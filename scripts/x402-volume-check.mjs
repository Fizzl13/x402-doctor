// One-off: compare x402 transaction counts across x402scan views (overall,
// facilitators, networks) for the same periods, to check the "Solana 76%,
// 23.2M in four weeks" claim (Artemis, 22 Aug - 19 Sep 2026).
const fs = await import('node:fs');
const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const UA = { 'user-agent': 'Mozilla/5.0 research' };

async function trpc(path, input) {
  const url = `https://www.x402scan.com/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const res = await fetch(url, { headers: UA });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).result.data.json;
}

// 1. Which tRPC procedures does the site use? Read its JS bundles.
const procs = new Set();
for (const page of ['/', '/facilitators', '/networks', '/transactions']) {
  try {
    const html = await (await fetch(`https://www.x402scan.com${page}`, { headers: UA })).text();
    for (const m of html.matchAll(/public\.[a-zA-Z]+(?:\.[a-zA-Z]+)+/g)) procs.add(m[0]);
    const chunks = [...new Set([...html.matchAll(/\/_next\/static\/[^"']+\.js/g)].map((m) => m[0]))];
    for (const c of chunks) {
      const js = await (await fetch(`https://www.x402scan.com${c}`, { headers: UA })).text();
      for (const m of js.matchAll(/["'`](public\.[a-zA-Z]+(?:\.[a-zA-Z]+)+)["'`]/g)) procs.add(m[1]);
      for (const m of js.matchAll(/public\s*\.\s*([a-zA-Z]+)\s*\.\s*([a-zA-Z]+)(?:\s*\.\s*([a-zA-Z]+))?/g)) procs.add(['public', m[1], m[2], m[3]].filter(Boolean).join('.'));
    }
    log(`page ${page}: ${chunks.length} chunks`);
  } catch (e) { log(`page ${page}: ${e.message}`); }
}
log(`\n## procedures seen (${procs.size}): ${[...procs].sort().join(', ')}`);

// 2. Totals for several periods.
for (const timeframe of [7, 28, 30]) {
  try { log(`\n## public.stats.overall timeframe ${timeframe}: ${JSON.stringify(await trpc('public.stats.overall', { timeframe })).slice(0, 1500)}`); }
  catch (e) { log(`stats.overall ${timeframe}: ${e.message}`); }
}

// 3. Anything about facilitators or networks, for 7 and 30 days.
const wanted = [...procs].filter((p) => /facilitator|network|chain|overall|stats/i.test(p));
for (const p of wanted) {
  for (const input of [{ timeframe: 7 }, { timeframe: 30 }, {}]) {
    try { log(`\n## ${p} ${JSON.stringify(input)}: ${JSON.stringify(await trpc(p, input)).slice(0, 2500)}`); break; }
    catch (e) { log(`${p} ${JSON.stringify(input)}: ${e.message.slice(0, 160)}`); }
  }
}

// 4. Context: analyses of how much x402 volume is real agent commerce.
for (const url of [
  'https://bitquery.io/investigations/x402-ai-agent-payments-audit',
  'https://www.pymnts.com/news/artificial-intelligence/2026/agentic-payments-are-growing-most-x402-payments-are-not-from-ai-agents',
  'https://www.chainalysis.com/blog/x402-agentic-payments-adoption/',
  'https://app.artemis.xyz/x402',
]) {
  try {
    const html = await (await fetch(url, { headers: UA })).text();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;|&\w+;/g, ' ').replace(/\s+/g, ' ');
    const s = text.split(/(?<=[.!?])\s+/).filter((x) => x.length < 450 && /\d/.test(x) && /(transaction|volume|agent|wash|bot|spam|test|facilitator|Solana|Base|%|real|organic|self)/i.test(x));
    log(`\n## ${url} (${s.length} sentences)`);
    for (const x of s.slice(0, 40)) log(`- ${x.trim()}`);
  } catch (e) { log(`${url}: ${e.message}`); }
}
fs.writeFileSync('volume-check.md', out.join('\n'));
