// Live check of the free Ichimoku /setups/preview after the #62 deploy: wait for it, then show it
// and check the homepage card. Free, read-only.
const B = "https://ichimoku-signal.onrender.com";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let body, status;
for (let i = 0; i < 40; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${B}/setups/preview`, { signal: AbortSignal.timeout(120000) });
    status = r.status; body = await r.text();
    console.log(new Date().toISOString(), "status", status, "ms", Date.now() - t0, body.slice(0, 120));
    if (status === 200) break;
  } catch (e) { console.log("error", e.message); }
  await wait(15000);
}
console.log("\nFULL:", body);
const t1 = Date.now();
const again = await fetch(`${B}/setups/preview`);
console.log("second call", again.status, "ms", Date.now() - t1, "(should be cached)");
const home = await (await fetch(`${B}/`, { headers: { accept: "text/html" } })).text();
console.log("homepage card:", /Yesterday's #1 trade setup/.test(home), "fetch:", home.includes("fetch('/setups/preview')"));
const paid = await fetch(`${B}/setups`);
console.log("/setups still paid:", paid.status);
