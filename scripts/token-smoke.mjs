// Wait until the four /.well-known/agent-registration.json files show the new fields (read-only GETs).
const want = { "x402-doctor.fizzl.eu": true, "ichimoku-signal.fizzl.eu": true, "presign-guard.fizzl.eu": true, "plaintext.fizzl.eu": false };
const done = new Set(); const end = Date.now() + 15 * 60_000;
while (done.size < 4 && Date.now() < end) {
  for (const [h, reg] of Object.entries(want)) {
    if (done.has(h)) continue;
    try {
      const j = await (await fetch(`https://${h}/.well-known/agent-registration.json`, { signal: AbortSignal.timeout(60000) })).json();
      const ok = j.x402Support === true && (!reg || (j.registrations || []).some((r) => r.agentRegistry === "solana:101:metaplex"));
      if (ok) { done.add(h); console.log("REG", h, "OK", JSON.stringify({ x402Support: j.x402Support, registrations: j.registrations })); }
    } catch (e) { console.log("REG", h, "ERR", e.message); }
  }
  if (done.size < 4) await new Promise((r) => setTimeout(r, 30000));
}
for (const h of Object.keys(want)) if (!done.has(h)) console.log("REG", h, "NOT YET");
