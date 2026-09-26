// Competitors of x402-trust.com: page text of each (free pages only, nothing paid).
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
const pages = [
  "https://x402.fuchss.app/", "https://402audit.com/", "https://x402station.com/", "https://x402watch.vercel.app/",
  "https://x402-sentinel.vercel.app/", "https://x402-trust.com/", "https://nohumans.directory/",
];
for (const u of pages) {
  try {
    const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (research)" }, signal: AbortSignal.timeout(20000) });
    const t = strip(await res.text());
    console.log(`\n=== ${u} HTTP ${res.status} (${t.length} chars)\n${t.slice(0, 1800)}`);
  } catch (e) { console.log(`\n=== ${u} ERROR ${e.message}`); }
}
// Our own hosts on each, where they have a lookup by host.
for (const u of ["https://x402.fuchss.app/provider/presign-guard.onrender.com", "https://402audit.com/leaderboard", "https://x402watch.vercel.app/api/feed?q=onrender"]) {
  try {
    const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (research)" }, signal: AbortSignal.timeout(20000) });
    const t = strip(await res.text());
    console.log(`\n=== ${u} HTTP ${res.status}\n${t.slice(0, 1500)}`);
  } catch (e) { console.log(`\n=== ${u} ERROR ${e.message}`); }
}
