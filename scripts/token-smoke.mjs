// presign-guard after the env change: up? key status? paid routes still 402 with the right payout?
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 16; i++) {
  const t = Date.now();
  const r = await fetch("https://presign-guard.onrender.com/health").then(async (x) => ({ s: x.status, b: await x.text() })).catch((e) => ({ s: 0, b: String(e) }));
  console.log(new Date().toISOString().slice(11, 19), r.s, `${Date.now() - t} ms`, r.b.slice(0, 200));
  if (r.s === 200 && /"pg1Key":"(unset|active|valid)/.test(r.b)) break;
  await sleep(15000);
}
for (const [u, m] of [["/v1/check", "POST"], ["/v1/token?chain=solana&address=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "GET"]]) {
  const r = await fetch("https://presign-guard.onrender.com" + u, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
  const h = r.headers.get("payment-required");
  const acc = h ? JSON.parse(Buffer.from(h, "base64").toString()).accepts.map((a) => `${a.network}->${a.payTo}`).join(", ") : "-";
  console.log(`${m} ${u.split("?")[0]}: ${r.status} ${acc}`);
}
