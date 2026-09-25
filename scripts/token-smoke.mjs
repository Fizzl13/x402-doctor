// One-off: Bazaar curation requirements and our status on agentic.market.
const get = async (u) => { try { const r = await fetch(u, { headers: { accept: "application/json, text/markdown, text/html" } }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } };

console.log("=== docs");
for (const u of ["https://docs.cdp.coinbase.com/x402/bazaar.md", "https://docs.cdp.coinbase.com/x402/bazaar", "https://docs.cdp.coinbase.com/llms.txt"]) {
  const r = await get(u);
  console.log(`\n# ${u} -> ${r.status}, ${r.text.length} chars`);
  if (u.endsWith("llms.txt")) { for (const l of r.text.split("\n")) if (/bazaar|curat|agentic/i.test(l)) console.log("  " + l.slice(0, 200)); continue; }
  const t = r.text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  let i = 0, n = 0;
  while ((i = t.toLowerCase().indexOf("curat", i)) !== -1 && n < 12) { console.log(`  …${t.slice(Math.max(0, i - 300), i + 700)}…\n`); i += 700; n++; }
}

console.log("\n=== agentic.market");
const list = await get("https://api.agentic.market/v1/services");
let services = [];
try { const j = JSON.parse(list.text); services = Array.isArray(j) ? j : j.services || j.data || j.items || []; console.log("list keys:", Array.isArray(j) ? "array" : Object.keys(j)); } catch { console.log("list not json", list.status, list.text.slice(0, 300)); }
console.log("count:", services.length);
if (services[0]) console.log("item keys:", Object.keys(services[0]).join(", "));
for (const k of ["curated", "featured", "verified", "tier", "status", "source"]) {
  const vals = {}; for (const s of services) { const v = JSON.stringify(s[k]); vals[v] = (vals[v] || 0) + 1; }
  if (Object.keys(vals).length > 1 || !("undefined" in vals)) console.log(k, vals);
}
for (const id of ["presign-guard-onrender-com", "x402-doctor-onrender-com", "ichimoku-signal-onrender-com"]) {
  const r = await get(`https://api.agentic.market/v1/services/${id}`);
  console.log(`\n# ${id} -> ${r.status}`);
  console.log(r.text.slice(0, 1200));
  const inList = services.find((s) => JSON.stringify(s).includes(id.replace(/-onrender-com$/, "")));
  console.log("in list:", Boolean(inList));
}
