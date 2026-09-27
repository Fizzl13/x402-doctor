// Live check after the site-scan deploy: Doctor's free web API. Never pays.
for (let round = 0; round < 16; round++) {
  const r = await fetch("https://x402-doctor.onrender.com/api/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://ichimoku-signal.onrender.com/signal/BTC-USDT" }) });
  const d = await r.json().catch(() => ({}));
  const c = (d.checks || []).find((x) => x.id === "metamask-site-scan");
  console.log(`round ${round}: overall=${d.overall} ${c ? `${c.status}: ${c.message}` : "(no site-scan check yet)"}`);
  if (c) break;
  await new Promise((res) => setTimeout(res, 30000));
}
