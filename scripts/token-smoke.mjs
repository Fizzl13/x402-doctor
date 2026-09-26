// Pay.sh catalog + how to get listed; ampersend marketplace API + seller docs. Read-only.
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const get = async (u) => { try { const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (research)" }, signal: AbortSignal.timeout(25000) }); return [r.status, await r.text(), r.headers.get("content-type") || ""]; } catch (e) { return [0, String(e), ""]; } };
const OURS = /presign-guard|ichimoku|x402-doctor|smartcontractexplainer|fizzl/i;
// Pay.sh
const [cs, cat] = await get("https://pay.sh/api/catalog");
let items = []; try { const j = JSON.parse(cat); items = Array.isArray(j) ? j : j.services || j.items || j.catalog || j.data || []; } catch {}
console.log(`pay.sh catalog ${cs}: ${items.length} services; ours: ${items.filter((s) => OURS.test(JSON.stringify(s))).map((s) => s.name || s.id).join(", ") || "none"}; sample keys: ${Object.keys(items[0] || {}).join(",")}`);
console.log("sample:", JSON.stringify(items[0] || cat.slice(0, 300)).slice(0, 600));
const [hs, home] = await get("https://pay.sh/");
const i = strip(home).indexOf("For API providers"); console.log("\nget-listed text:", strip(home).slice(i, i + 700));
const gl = home.match(/id="get-listed"[\s\S]{0,3000}/); if (gl) console.log("\n#get-listed:", strip(gl[0]).slice(0, 1200));
for (const u of ["https://pay.sh/docs/using-pay/skills/index.md", "https://pay.sh/docs/building-with-pay/llms.txt", "https://raw.githubusercontent.com/solana-foundation/pay-skills/main/README.md", "https://raw.githubusercontent.com/solana-foundation/pay-skills/main/CONTRIBUTING.md"]) {
  const [s, t] = await get(u); console.log(`\n=== ${u} ${s}\n${strip(t).slice(0, 2200)}`);
}
// ampersend
for (const u of ["https://app.ampersend.ai/api/marketplace", "https://app.ampersend.ai/api/services", "https://ampersend.ai/llms.txt", "https://docs.ampersend.ai/llms.txt"]) {
  const [s, t] = await get(u); console.log(`\n=== ${u} ${s} ours=${OURS.test(t)}\n${strip(t).slice(0, 2000)}`);
}
