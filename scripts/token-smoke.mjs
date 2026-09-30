// Wait for x402-doctor /api/stats to go live (read-only GETs).
const end = Date.now() + 15 * 60_000;
while (Date.now() < end) {
  try {
    const r = await fetch("https://x402-doctor.fizzl.eu/api/stats", { headers: { origin: "https://ai.fizzl.eu" }, signal: AbortSignal.timeout(60000) });
    const body = await r.text();
    console.log(new Date().toISOString(), r.status, r.headers.get("access-control-allow-origin"), body.slice(0, 400));
    if (r.status === 200 && body.includes('"today"')) process.exit(0);
  } catch (e) { console.log("ERR", e.message); }
  await new Promise((r) => setTimeout(r, 20000));
}
process.exit(1);
