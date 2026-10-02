// One-off: wallet.fizzl.eu over https.
for (const path of ["/health", "/", "/api/state", "/demo"]) {
  try { const r = await fetch("https://wallet.fizzl.eu" + path, { signal: AbortSignal.timeout(90000) }); console.log("WF", path, r.status, (await r.text()).replace(/\s+/g, " ").slice(0, 60)); }
  catch (e) { console.log("WF", path, "ERR", e.cause?.code ?? e.message); }
}
