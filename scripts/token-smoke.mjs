// One-off: is /demo live on wallet.fizzl.eu?
for (const path of ["/demo", "/health"]) {
  try { const r = await fetch("https://wallet.fizzl.eu" + path, { signal: AbortSignal.timeout(90000) }); const t = await r.text(); console.log("WF", path, r.status, /LIVE DEMO/.test(t) ? "has-demo-banner" : "", t.slice(0, 40).replace(/\s+/g, " ")); }
  catch (e) { console.log("WF", path, "ERR", e.cause?.code ?? e.message); }
}
