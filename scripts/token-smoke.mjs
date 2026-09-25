const get = async (u) => { try { const r = await fetch(u); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } };
for (const u of ["https://docs.cdp.coinbase.com/x402/seller/get-discovered.md", "https://agentic.market/llms.txt"]) {
  const r = await get(u);
  console.log(`\n######## ${u} -> ${r.status}\n${r.text.slice(0, 14000)}`);
}
