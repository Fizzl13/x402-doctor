// Claim 3 nohumans listings and set the need-first descriptions. Edit keys stay in memory, never printed.
const API = "https://api.nohumans.directory";
const EMAIL = "Fizzl13@protonmail.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = [
  { id: "ee5c650c-d63", what: "presign token", proof: ["file", "https://presign-guard.onrender.com/.well-known/nohumans-claim", "857bd9d55cb8d42eb41f294993a7f420223870a976d70460"],
    description: "Is this token safe to buy, hold or accept? Checks a Solana or EVM token for honeypot and rug-pull signs (mint or freeze authority still active, LP not locked, buy/sell tax, low liquidity, brand-new token, concentrated holders) and answers green/orange/red with a grade (SAFE/CAUTION/RISKY/AVOID), the reasons, a one-line summary and market data." },
  { id: "1259df9a-70c", what: "ichimoku signal", proof: ["header", "https://ichimoku-signal.onrender.com/signal/:pair", "55bdf1ae4520a713dfff68576ecf3eceea50ce914f7e890f"],
    description: "Is a crypto pair bullish, bearish or neutral right now? Trend signal from the Ichimoku Cloud (cloud position, tenkan/kijun cross) for BTC, ETH, SOL or any top-200 coin on any interval, from live candles on Binance.US, Kraken, Gate or MEXC." },
  { id: "3e22b66d-48d", what: "ichimoku levels", proof: ["header", "https://ichimoku-signal.onrender.com/levels/:pair", "5d07e40624c14991af20fd512975ef4d82ace41d8a30e1fe"],
    description: "Support and resistance levels, stop loss and take profit targets for a crypto pair (top 200 coins): swing highs/lows, pivots, ATR, Fibonacci retracements and Ichimoku levels, plus a long and a short plan (entry, stop, two targets, risk/reward). Levels from price history, not trade advice." },
];
for (const j of jobs) {
  const [kind, url, token] = j.proof;
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    const r = await fetch(url).catch(() => null);
    ok = kind === "header" ? r?.headers.get("x-nohumans-claim") === token : r?.status === 200 && (await r.text()).trim() === token;
    if (!ok) await sleep(20000);
  }
  console.log(`proof ${ok ? "live" : "NOT LIVE"}: ${j.what}`);
  if (!ok) continue;
  const c = await fetch(`${API}/v1/listings/${j.id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL }) });
  const cd = await c.json().catch(() => ({}));
  const key = cd.edit_token || cd.claim_token || cd.token;
  console.log(`claim ${j.what}: ${c.status} ok=${cd.ok} origin=${cd.origin} error=${cd.error ?? ""} key=${key ? "received (not printed)" : "none"}`);
  if (!key) continue;
  const p = await fetch(`${API}/v1/listings/${j.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-claim-token": key }, body: JSON.stringify({ description: j.description }) });
  console.log(`edit ${j.what}: ${p.status}`);
  const d = await (await fetch(`${API}/v1/listings/${j.id}`)).json().catch(() => ({}));
  console.log(`now ${j.what}: origin=${d.origin} status=${d.status} desc="${String(d.description).slice(0, 70)}…"`);
}
