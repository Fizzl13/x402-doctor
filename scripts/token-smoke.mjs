// Wait for the new Digital Twin profile, then ask one question (one Claude call).
const base = "https://digital-twin-ztpp.onrender.com";
const end = Date.now() + 15 * 60_000; let live = false;
while (Date.now() < end) {
  try {
    const c = await (await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(60000) })).json();
    if (JSON.stringify(c).includes("x402 and AI agents")) { live = true; console.log("TWIN config has the new suggestion"); break; }
    console.log("waiting", new Date().toISOString());
  } catch (e) { console.log("ERR", e.message); }
  await new Promise((r) => setTimeout(r, 30000));
}
if (live) {
  const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", origin: "https://fizzl.eu" }, body: JSON.stringify({ question: "What does Frits know about x402 and AI agents?", conversationId: "check-" + Date.now() }), signal: AbortSignal.timeout(90000) });
  console.log("TWIN", r.status, (await r.text()).slice(0, 1500));
} else console.log("TWIN not live after 15 min");
