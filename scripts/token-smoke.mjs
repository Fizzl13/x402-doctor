// Claim 4 nohumans.directory listings and edit them in the same run. The private edit
// keys are used in memory only and never printed (this log is public).
const API = "https://api.nohumans.directory";
const EMAIL = "Fizzl13@protonmail.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = [
  { id: "22c4a0f9-8dd", what: "doctor preflight", proof: ["header", "https://x402-doctor.onrender.com/api/v1/preflight", "5acafd994ef2d88b3d9c85d7df2e0b20052a747cb41a76bd"], patch: { category: "developer.x402-audit" } },
  { id: "b8dc5b73-c7b", what: "doctor diagnose", proof: ["header", "https://x402-doctor.onrender.com/api/v1/diagnose", "fcb9d41a3ed1dfeebf69bbae3f83c16f1ce5ab491ba36fdf"], patch: { category: "developer.x402-audit" } },
  { id: "3cdb4ceb-a86", what: "doctor fix", proof: ["header", "https://x402-doctor.onrender.com/api/v1/fix", "0e189afed26f2f3f108f29965f2780a3d02dfc1727de89e0"], patch: { category: "developer.x402-audit" } },
  { id: "1259df9a-70c", what: "ichimoku signal", proof: ["file", "https://ichimoku-signal.onrender.com/.well-known/nohumans-claim", "40ce666e9b3ce343f51fdaebac774eb9c77ff810601c1698"],
    patch: { description: "Ichimoku Cloud signal (tenkan/kijun cross, cloud position, bullish/bearish/neutral) for a crypto pair on any interval from 1m to 1M, from live candles: Binance.US, then Kraken, Gate and MEXC (top 200 coins)." } },
];
// 1) Wait until the deploys serve the tokens.
for (const j of jobs) {
  const [kind, url, token] = j.proof;
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    const r = await fetch(url).catch(() => null);
    ok = kind === "header" ? r?.headers.get("x-nohumans-claim") === token : r?.status === 200 && (await r.text()).trim() === token;
    if (!ok) await sleep(20000);
  }
  console.log(`proof ${ok ? "live" : "NOT LIVE"}: ${j.what} (${kind})`);
  j.live = ok;
}
// 2) Claim and edit.
for (const j of jobs) {
  if (!j.live) { console.log(`skip ${j.what}: proof not live`); continue; }
  const c = await fetch(`${API}/v1/listings/${j.id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL }) });
  const cd = await c.json().catch(() => ({}));
  const key = cd.edit_token || cd.claim_token || cd.token;
  const { edit_token, claim_token, token, ...rest } = cd;
  console.log(`claim ${j.what}: ${c.status} ${JSON.stringify(rest).slice(0, 300)} key=${key ? "received (not printed)" : "none"}`);
  if (!key) continue;
  const p = await fetch(`${API}/v1/listings/${j.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-claim-token": key }, body: JSON.stringify(j.patch) });
  const pd = await p.json().catch(() => ({}));
  console.log(`edit ${j.what}: ${p.status} ${JSON.stringify({ category: pd.category ?? pd.listing?.category, description: (pd.description ?? pd.listing?.description ?? "").slice(0, 90), error: pd.error, message: pd.message })}`);
}
// 3) What the directory shows now.
for (const j of jobs) {
  const d = await (await fetch(`${API}/v1/listings/${j.id}`)).json().catch(() => ({}));
  console.log(`now ${j.what}: origin=${d.origin} category=${d.category} status=${d.status} desc="${String(d.description).slice(0, 80)}"`);
}
