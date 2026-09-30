// After the deploys: read the four agent registrations once (read-only), so the new log line can be checked.
await new Promise((r) => setTimeout(r, 4 * 60_000));
for (const h of ["x402-doctor", "ichimoku-signal", "presign-guard", "plaintext"]) {
  try { const r = await fetch(`https://${h}.fizzl.eu/.well-known/agent-registration.json`, { headers: { "user-agent": "fizzl-registration-log-check/1.0" }, signal: AbortSignal.timeout(60000) }); console.log("REG", h, r.status, new Date().toISOString()); } catch (e) { console.log("REG", h, "ERR", e.message); }
}
