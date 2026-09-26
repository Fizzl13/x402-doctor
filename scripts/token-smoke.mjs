// Claim the presign /v1/check and /v1/token nohumans listings and set the new wording (edit keys never printed),
// then wait for the search index and re-run the ranking test. Free.
const API = "https://api.nohumans.directory";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = "https://presign-guard.onrender.com";
const L = [
  { id: "5b72a75f-172", probe: () => fetch(`${B}/v1/check`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    token: "020b9323050d8e581f31efb341ff9996b39d53398aa0f5ae",
    description: "Is this transaction, approval or signature safe to sign? Pre-sign verdict (green/orange/red + reason codes) for EVM transactions, token approvals and Permit/Permit2/EIP-3009/Seaport signatures. Screens the spender or recipient wallet for OFAC sanctions and scam, phishing or theft reports, and flags unlimited allowances, plain-wallet spenders and risky tokens." },
  { id: "ee5c650c-d63", probe: () => fetch(`${B}/v1/token?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`),
    token: "0e7df9e10c9447df53fa46d72908bd76f7729b4e2d6abe3b",
    description: "Is this token safe to buy, or a honeypot or rug pull? Checks a Solana or EVM token before you buy, hold or accept it (mint or freeze authority still active, LP not locked, buy/sell tax, low liquidity, brand-new token, concentrated holders) and answers green/orange/red with a grade (SAFE/CAUTION/RISKY/AVOID), the reasons, a one-line summary and market data." },
];
for (const l of L) {
  let live = false;
  for (let i = 0; i < 40 && !live; i++) {
    const r = await l.probe().catch(() => null);
    live = r?.headers.get("x-nohumans-claim") === l.token;
    if (!live) await sleep(15000);
  }
  console.log(`${l.id}: proof ${live ? "live" : "NOT LIVE"}`);
  if (!live) continue;
  const c = await fetch(`${API}/v1/listings/${l.id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "Fizzl13@protonmail.com" }) });
  const cd = await c.json().catch(() => ({}));
  const key = cd.edit_token || cd.claim_token || cd.token;
  console.log(`  claim: ${c.status} ok=${cd.ok} key=${key ? "received (not printed)" : "none"} ${cd.error ?? ""}`);
  if (!key) continue;
  const p = await fetch(`${API}/v1/listings/${l.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-claim-token": key }, body: JSON.stringify({ description: l.description }) });
  console.log(`  edit: ${p.status}`);
}
for (let i = 0; i < 15; i++) {
  const ds = await Promise.all(L.map(async (l) => (await fetch(`${API}/v1/listings/${l.id}`)).json()));
  if (ds.every((d) => d.embedding_synced_at >= d.updated_at)) { for (const d of ds) console.log(`embedded ${d.id}: "${d.description.slice(0, 70)}…"`); break; }
  await sleep(20000);
}
console.log("");
await import("./rank.mjs");
