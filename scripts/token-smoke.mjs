// Claim the Ichimoku /signals and /scan nohumans listings and correct their prices ($0.15 and $0.10).
// Edit keys are never printed. Waits for the deploy that serves the challenge headers. Free.
const API = "https://api.nohumans.directory";
const B = "https://ichimoku-signal.onrender.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = [
  { id: "5b091fee-e8d", path: "/signals/BTC-USDT", token: "39f6bbe29fd95d121c32c35066c95e800b54efb0c725908e", price: 0.15 },
  { id: "1c8d9230-124", path: "/scan", token: "be8176b1c9c6fc39c234eaf43aaed0cff9aff0d6d3ab0232", price: 0.1 },
];
for (const l of L) {
  let live = false;
  for (let i = 0; i < 56 && !live; i++) {
    const r = await fetch(B + l.path).catch(() => null);
    live = r?.headers.get("x-nohumans-claim") === l.token;
    if (!live) await sleep(15000);
  }
  console.log(`${l.id} ${l.path}: proof ${live ? "live" : "NOT LIVE"}`);
  if (!live) continue;
  const c = await fetch(`${API}/v1/listings/${l.id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "Fizzl13@protonmail.com" }) });
  const cd = await c.json().catch(() => ({}));
  const key = cd.edit_token || cd.claim_token || cd.token;
  console.log(`  claim: ${c.status} ok=${cd.ok} key=${key ? "received (not printed)" : "none"} ${cd.error ?? ""}`);
  if (!key) continue;
  const p = await fetch(`${API}/v1/listings/${l.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-claim-token": key }, body: JSON.stringify({ price_amount: l.price }) });
  const pd = await p.json().catch(() => ({}));
  console.log(`  edit: ${p.status} ${pd.error ?? ""}`);
  const d = await (await fetch(`${API}/v1/listings/${l.id}`)).json();
  console.log(`  now: price=${d.price_amount} ${d.price_currency} status=${d.status}`);
}
