// One-off: live check of the trend-paper Hyperliquid funding percentiles (read-only). Output is data only. Run 2026-10-01T0815Z.
const HL = "https://api.hyperliquid.xyz/info";
const DAY_MS = 86400000;
async function hlPost(body, fetchFn = globalThis.fetch) {
  for (let i = 0; i < 6; i++) {
    const r = await fetchFn(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  throw new Error("hyperliquid unavailable");
}
async function fundingPercentiles(coins, nowMs, fetchFn) {
  const listed = new Set(((await hlPost({ type: "meta" }, fetchFn)).universe || []).map((u) => u.name));
  const out = {};
  for (const coin of coins) {
    if (!listed.has(coin)) { out[coin] = null; continue; }
    try {
      const byDay = new Map();
      let t = nowMs - 93 * DAY_MS;
      for (let g = 0; g < 10; g++) {
        const rows = await hlPost({ type: "fundingHistory", coin, startTime: t }, fetchFn);
        if (!rows.length) break;
        for (const r of rows) { const d = Math.floor(r.time / DAY_MS); byDay.set(d, (byDay.get(d) || 0) + Number(r.fundingRate)); }
        const last = rows[rows.length - 1].time;
        if (last <= t || rows.length < 400) break;
        t = last + 1;
      }
      const today = Math.floor(nowMs / DAY_MS);
      const sum3 = (d) => (byDay.get(d - 1) || 0) + (byDay.get(d - 2) || 0) + (byDay.get(d - 3) || 0);
      const hist = []; for (let d = today - 90; d < today; d++) hist.push(sum3(d));
      const now = sum3(today);
      out[coin] = hist.length ? hist.filter((x) => x < now).length / hist.length : null;
    } catch {
      out[coin] = null; // no data: not skipped
    }
  }
  return out;
}
const t = Date.now(); console.log("FUND", JSON.stringify(await fundingPercentiles(["BTC","ETH","HYPE","XPL","BR","DRV","ZEC","TAO"], Date.now())), `${Date.now()-t}ms`);
