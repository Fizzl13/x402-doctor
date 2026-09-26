// 1) Our endpoints on x402watch (free feed). 2) nohumans.directory: are we listed, and its submission rules. Read-only.
const ours = ["presign-guard.onrender.com", "ichimoku-signal.onrender.com", "x402-doctor.onrender.com", "smartcontractexplainer.onrender.com"];
const get = async (u, accept = "application/json") => {
  const r = await fetch(u, { headers: { accept, "user-agent": "fizzl-research/1" }, signal: AbortSignal.timeout(25000) });
  return { status: r.status, text: await r.text() };
};
console.log("===== x402watch");
for (const h of ours) {
  const { status, text } = await get(`https://x402watch.vercel.app/api/feed?q=${h}&limit=100`);
  let d; try { d = JSON.parse(text); } catch { console.log(h, status, text.slice(0, 200)); continue; }
  console.log(`\n-- ${h}: ${d.total} rows (feed generated ${d.generatedAt})`);
  for (const r of d.rows) console.log(`  ${String(r.score).padStart(3)} ${r.method} ${r.url.replace(/^https:\/\/[^/]+/, "")} | ${r.lastStatus} up=${r.uptime} ${r.medianMs}ms price=${r.declaredAmount}/${r.livePrice} drift=${r.priceDrift} payers30d=${r.payers30d} checks=${r.checks} src=${r.sources} ex=${r.hasInputExample}/${r.hasOutputExample}`);
}
console.log("\n===== nohumans.directory");
for (const h of ours) {
  const { status, text } = await get(`https://nohumans.directory/v1/discover?q=${encodeURIComponent(h)}`);
  console.log(`\n-- discover ${h}: ${status} ${text.slice(0, 700)}`);
}
for (const path of ["/llms.txt", "/how", "/v1", "/docs", "/openapi.json", "/.well-known/x402"]) {
  const { status, text } = await get(`https://nohumans.directory${path}`, "text/plain, application/json, text/html");
  const t = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  console.log(`\n-- ${path}: ${status} (${t.length})\n${t.slice(0, 3500)}`);
}
