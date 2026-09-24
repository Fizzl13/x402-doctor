// One-off: after the deploy, does the Doctor settle Solana through PayAI?
const payai = JSON.parse(await (await fetch('https://facilitator.payai.network/supported')).text());
const signers = payai.kinds.filter((k) => k.network.startsWith('solana')).map((k) => k.extra && k.extra.feePayer);
for (let i = 0; i < 12; i++) {
  const h = await (await fetch('https://x402-doctor.onrender.com/api/health')).json().catch(() => ({}));
  const r = await fetch('https://x402-doctor.onrender.com/api/v1/diagnose?url=https://example.com');
  const c = JSON.parse(Buffer.from(r.headers.get('payment-required') || 'e30=', 'base64').toString());
  const fp = (c.accepts || []).filter((a) => a.network.startsWith('solana')).map((a) => a.extra && a.extra.feePayer)[0];
  console.log(`try ${i}: facilitator="${h.paid && h.paid.facilitator}", solana feePayer ${fp} ${signers.includes(fp) ? '= PayAI' : '(not PayAI)'}`);
  if (h.paid && h.paid.facilitator === 'cdp for base, payai for solana') break;
  await new Promise((r) => setTimeout(r, 60000));
}
