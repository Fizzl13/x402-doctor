// Pay.sh and ampersend discover (plus agentic.market for presign): are we listed, and how do you submit? Read-only.
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const OURS = /presign-guard|ichimoku-signal|x402-doctor|smartcontractexplainer|fizzl/i;
async function show(u, n = 2500) {
  try {
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (research)", accept: "text/html,application/json" }, signal: AbortSignal.timeout(25000), redirect: "follow" });
    const raw = await r.text();
    const t = r.headers.get("content-type")?.includes("json") ? raw : strip(raw);
    const hits = [...new Set((raw.match(/[a-z0-9.-]*(presign-guard|ichimoku-signal|x402-doctor|smartcontractexplainer)[a-z0-9./-]*/gi) || []))].slice(0, 10);
    console.log(`\n=== ${u} → ${r.status} ${r.url !== u ? "(→ " + r.url + ")" : ""} (${t.length} chars) ours: ${hits.length ? hits.join(", ") : "none"}\n${t.slice(0, n)}`);
    const links = [...new Set([...raw.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /submit|add|list|docs|seller|provider|register|api|llms|openapi|github/i.test(h)))].slice(0, 25);
    if (links.length) console.log("links:", links.join(" "));
    return raw;
  } catch (e) { console.log(`\n=== ${u} ERROR ${e.message}`); }
}
for (const u of ["https://pay.sh", "https://pay.sh/llms.txt", "https://pay.sh/docs", "https://app.ampersend.ai/discover", "https://ampersend.ai", "https://app.ampersend.ai/llms.txt"]) await show(u);
for (const q of ["presign", "ichimoku", "x402-doctor"]) {
  await show(`https://pay.sh/search?q=${q}`, 600);
  await show(`https://app.ampersend.ai/discover?q=${q}`, 600);
}
