// nohumans.directory: submit Ichimoku /setups (free, 5 per subdomain, 4 used), and read the stored price of
// the /signals and /scan listings after today's price change. Claim/edit tokens never printed. Nothing paid.
const API = "https://api.nohumans.directory";
for (const [id, what] of [["5b091fee-e8d", "/signals (now $0.15)"], ["1c8d9230-124", "/scan (now $0.10)"]]) {
  const d = await (await fetch(`${API}/v1/listings/${id}`)).json().catch(() => ({}));
  console.log(`${what}: stored price ${d.price_amount} ${d.price_currency} status=${d.status} updated=${d.updated_at ? new Date(d.updated_at * 1000).toISOString() : "-"}`);
}
const listing = {
  name: "Ichimoku Signal: ranked trade setups",
  endpoint_url: "https://ichimoku-signal.onrender.com/setups",
  price_amount: 0.5, price_currency: "USDC", chains: ["base", "solana"], category: "data.crypto",
  sample_query: "https://ichimoku-signal.onrender.com/api/trend/BTC-USDT",
  description: "Which crypto coins have a trade setup right now? For 148 top-200 coins: a six-indicator signal (Ichimoku, RSI, MACD, EMA, Bollinger, OBV) plus entry, stop loss, two take profit targets and risk/reward, ranked best first. Filter long/short, min R/R, top N.",
  submitter_email: "Fizzl13@protonmail.com",
};
console.log("description length", listing.description.length);
const res = await fetch(`${API}/v1/listings`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(listing) });
const body = await res.json().catch(() => ({}));
console.log(`${res.status} ${JSON.stringify({ id: body.id ?? body.listing?.id, status: body.status ?? body.listing?.status, allowance: body.submission_allowance, error: body.error, message: body.message, claim: body.claim_token ? "received (not printed)" : undefined })}`);
