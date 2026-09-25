const get = async (u) => { try { const r = await fetch(u); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } };
const doc = await get("https://docs.cdp.coinbase.com/x402/bazaar.md");
console.log(doc.text);
for (const u of ["https://api.agentic.market/v1/services?limit=1", "https://api.agentic.market/v1/services?limit=200&offset=0"]) {
  const r = await get(u);
  try { const j = JSON.parse(r.text); console.log(u, "total:", j.total, "returned:", j.services?.length, "enriched:", j.services?.filter((s) => s.enriched).length);
    if (j.services?.length > 1) { const cats = {}; for (const s of j.services) cats[s.category || "(none)"] = (cats[s.category || "(none)"] || 0) + 1; console.log("categories:", JSON.stringify(cats)); console.log("sample enriched:", JSON.stringify(j.services.find((s) => s.enriched && s.providerUrl) ?? {}).slice(0, 700)); }
  } catch { console.log(u, r.status, r.text.slice(0, 300)); }
}
for (const u of ["https://agentic.market", "https://agentic.market/about", "https://agentic.market/submit", "https://agentic.market/llms.txt"]) {
  const r = await get(u);
  const t = r.text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const hits = []; let i = 0;
  while ((i = t.search(/curat|submit|apply|list your|get listed/i)) !== -1 && hits.length < 6) { hits.push(t.slice(Math.max(0, i - 200), i + 400)); t2: break; }
  console.log(`\n# ${u} -> ${r.status}, ${t.length} chars`);
  const re = /curat|submit|apply|list your|get listed/ig; let m; let n = 0;
  while ((m = re.exec(t)) && n < 6) { console.log("  …" + t.slice(Math.max(0, m.index - 200), m.index + 400) + "…"); re.lastIndex = m.index + 400; n++; }
}
