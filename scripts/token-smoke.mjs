// Live check: fizzl brand on the three homepages after the redeploy.
const pages = {
  presign: "https://presign-guard.onrender.com/",
  ichimoku: "https://ichimoku-signal.onrender.com/",
  doctor: "https://x402-doctor.onrender.com/",
};
const want = ["fizzl brand v1", "More from fizzl", 'name="theme-color" content="#0d1117"'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, url] of Object.entries(pages)) {
  let ok = false, last = "";
  for (let i = 0; i < 40 && !ok; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "text/html" } });
      const html = await res.text();
      const missing = want.filter((w) => !html.includes(w));
      last = `HTTP ${res.status}, missing: ${missing.join(" | ") || "none"}, h1: ${(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]?.replace(/<[^>]+>/g, "").trim()}`;
      ok = res.ok && !missing.length;
    } catch (e) { last = String(e); }
    if (!ok) await sleep(20000);
  }
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${last}`);
  for (const p of ["/health", "/.well-known/x402-trust.txt"]) {
    const r = await fetch(new URL(p, url)).catch((e) => ({ status: String(e) }));
    console.log(`     ${p} → ${r.status}`);
  }
}
