// Live check after #63: wait until /setups/preview's "since" is computed from real later candles
// (not "open" at exactly the entry price, the bug), then print it. Free, read-only.
const B = "https://ichimoku-signal.onrender.com";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let d;
for (let i = 0; i < 48; i++) {
  try {
    const r = await fetch(`${B}/setups/preview`, { signal: AbortSignal.timeout(120000) });
    d = await r.json().catch(() => null);
    const s = d && d.since, e = d && d.setup && d.setup.entry;
    console.log(new Date().toISOString(), r.status, d && d.setup && `${d.setup.pair} ${d.setup.direction} entry ${e}`, JSON.stringify(s));
    if (r.status === 200 && (s === null || s.result !== "open" || s.price_now !== e)) break;
  } catch (err) { console.log("error", err.message); }
  await wait(15000);
}
console.log("\nFULL:", JSON.stringify(d));
