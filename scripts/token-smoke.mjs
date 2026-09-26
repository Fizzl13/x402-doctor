// Claim the presign /v1/check nohumans listing and set its need-first description (edit key never printed),
// then wait for the search index to pick it up and re-run the ranking test.
const API = "https://api.nohumans.directory";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = "5b72a75f-172", TOKEN = "bdd666be53e1fa1cc7300c6785508961f70631ed91c74027";
const DESCRIPTION = "Is this transaction, approval or signature safe to sign? Pre-sign verdict (green/orange/red + reason codes) for EVM transactions, token approvals and Permit/Permit2/EIP-3009/Seaport signatures: flagged or sanctioned spenders, unlimited allowances, plain-wallet spenders and risky tokens.";
let live = false;
for (let i = 0; i < 30 && !live; i++) {
  const r = await fetch("https://presign-guard.onrender.com/.well-known/nohumans-claim").catch(() => null);
  live = r?.status === 200 && (await r.text()).trim() === TOKEN;
  if (!live) await sleep(20000);
}
console.log(`proof ${live ? "live" : "NOT LIVE"}`);
if (live) {
  const c = await fetch(`${API}/v1/listings/${ID}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "Fizzl13@protonmail.com" }) });
  const cd = await c.json().catch(() => ({}));
  const key = cd.edit_token || cd.claim_token || cd.token;
  console.log(`claim: ${c.status} ok=${cd.ok} origin=${cd.origin} key=${key ? "received (not printed)" : "none"}`);
  if (key) {
    const p = await fetch(`${API}/v1/listings/${ID}`, { method: "PATCH", headers: { "content-type": "application/json", "x-claim-token": key }, body: JSON.stringify({ description: DESCRIPTION }) });
    console.log(`edit: ${p.status}`);
  }
  for (let i = 0; i < 12; i++) {
    const d = await (await fetch(`${API}/v1/listings/${ID}`)).json();
    if (d.embedding_synced_at >= d.updated_at) { console.log(`embedded at ${new Date(d.embedding_synced_at * 1000).toISOString()}: "${d.description.slice(0, 60)}…"`); break; }
    await sleep(20000);
  }
  console.log("");
  await import("./rank.mjs");
}
