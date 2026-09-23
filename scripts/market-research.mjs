// One-off x402 market research: x402scan top sellers (tx count, volume,
// unique buyers, 30d/7d), CDP Bazaar catalog stats, and article excerpts.
const out = [];
const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const fs = await import("node:fs");

async function trpc(path, input) {
  const url = `https://www.x402scan.com/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 research" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).result.data.json;
}

const usd = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `$${(n > 1e6 ? n / 1e6 : n).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : String(v);
};

fs.mkdirSync("research-out", { recursive: true });
for (const timeframe of [30, 7]) {
  for (const sortId of ["tx_count", "total_amount", "unique_buyers"]) {
    try {
      const data = await trpc("public.sellers.bazaar.list", { pagination: { page: 0, page_size: 60 }, timeframe, sorting: { id: sortId, desc: true } });
      fs.writeFileSync(`research-out/sellers-${timeframe}d-${sortId}.json`, JSON.stringify(data, null, 1));
      log(`\n## x402scan top servers, ${timeframe}d, by ${sortId} (total ${data.total_count ?? "?"})`);
      for (const [i, it] of (data.items || []).entries()) {
        const o = it.origins?.[0] || {};
        log(`${i + 1}. ${o.origin || it.recipients?.[0]} | tx ${it.tx_count} | amt ${it.total_amount} | buyers ${it.unique_buyers} | ${String(o.title || "").slice(0, 60)} | ${String(o.description || "").replace(/\s+/g, " ").slice(0, 140)}`);
      }
    } catch (e) { log(`sellers ${timeframe} ${sortId}: ${e.message}`); }
  }
}
try {
  const s = await trpc("public.stats.overall", { timeframe: 30 });
  log(`\n## x402scan overall 30d: ${JSON.stringify(s).slice(0, 800)}`);
} catch (e) { log(`stats: ${e.message}`); }

// CDP Bazaar catalog
try {
  const items = [];
  for (let offset = 0; offset < 40000; offset += 500) {
    const res = await fetch(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${offset}`);
    if (!res.ok) { log(`CDP HTTP ${res.status}`); break; }
    const page = (await res.json()).items || [];
    items.push(...page);
    if (page.length < 500) break;
  }
  fs.writeFileSync("research-out/cdp-bazaar.json", JSON.stringify(items));
  log(`\n## CDP Bazaar: ${items.length} resources`);
  log(`sample item keys: ${Object.keys(items[0] || {}).join(", ")}`);
  log(`sample: ${JSON.stringify(items[0]).slice(0, 1200)}`);
  const hosts = new Map();
  const prices = [];
  const words = new Map();
  const STOP = new Set("the a an and or of to for in on with by from get your this that is are api data x402 using via per call returns return based".split(" "));
  for (const it of items) {
    let host = "?"; try { host = new URL(it.resource).host; } catch {}
    hosts.set(host, (hosts.get(host) || 0) + 1);
    const a = it.accepts?.[0] || {};
    const amt = Number(a.maxAmountRequired ?? a.amount);
    if (Number.isFinite(amt)) prices.push(amt / 1e6);
    const desc = `${a.description || it.description || ""}`.toLowerCase();
    for (const w of new Set(desc.match(/[a-z][a-z-]{3,}/g) || [])) if (!STOP.has(w)) words.set(w, (words.get(w) || 0) + 1);
  }
  prices.sort((x, y) => x - y);
  const q = (p) => prices[Math.floor(p * (prices.length - 1))];
  log(`hosts: ${hosts.size}; top hosts by resource count: ${[...hosts].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([h, n]) => `${h}(${n})`).join(", ")}`);
  log(`price USD p10 ${q(0.1)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)}`);
  log(`top description words: ${[...words].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([w, n]) => `${w}:${n}`).join(" ")}`);
  const recent = items.filter((i) => i.lastUpdated && Date.now() - Date.parse(i.lastUpdated) < 7 * 864e5).length;
  log(`updated in last 7d: ${recent}`);
} catch (e) { log(`CDP: ${e.message}`); }

// Articles: sentences with numbers and key terms
const articles = [
  "https://bitquery.io/investigations/x402-ai-agent-payments-audit",
  "https://www.chainalysis.com/blog/x402-agentic-payments-adoption/",
  "https://www.pymnts.com/news/artificial-intelligence/2026/agentic-payments-are-growing-most-x402-payments-are-not-from-ai-agents",
  "https://www.web3trackers.com/x402-dashboard",
  "https://cryptonews.com/news/x402-solana-news-ai-payments/",
  "https://www.allium.so/blog/x402-explained-the-internet-native-payments-standard-for-apis-data-and-agent-commerce/",
];
for (const url of articles) {
  try {
    const html = await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })).text();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#\d+;|&\w+;/g, " ").replace(/\s+/g, " ");
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length < 400 && /\d/.test(s) && /(agent|service|seller|merchant|volume|payment|transaction|categor|top|largest|share|%|API|data|inference|search|scrap|trading|LLM|model)/i.test(s));
    log(`\n## ${url} (${sentences.length} relevant sentences)`);
    for (const s of sentences.slice(0, 45)) log(`- ${s.trim()}`);
  } catch (e) { log(`${url}: ${e.message}`); }
}
fs.writeFileSync("research-out/report.md", out.join("\n"));
