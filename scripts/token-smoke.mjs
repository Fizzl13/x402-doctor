// presign-guard after the Starter upgrade: up, and the three paid routes still answer 402.
for (let i = 0; i < 3; i++) {
  const t = Date.now(); const r = await fetch("https://presign-guard.onrender.com/health").catch((e) => ({ status: String(e) }));
  console.log(`health ${i + 1}: ${r.status} in ${Date.now() - t} ms`);
}
for (const [u, m] of [["/v1/check", "POST"], ["/v1/check/explain", "POST"], ["/v1/token?chain=solana&address=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "GET"]]) {
  const r = await fetch("https://presign-guard.onrender.com" + u, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
  const h = r.headers.get("payment-required");
  const nets = h ? JSON.parse(Buffer.from(h, "base64").toString()).accepts.map((a) => a.network).join(", ") : "-";
  console.log(`${m} ${u.split("?")[0]}: ${r.status} (${nets})`);
}
