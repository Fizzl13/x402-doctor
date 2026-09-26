// Submit our 8 unlisted endpoints to nohumans.directory (free: 5 per onrender subdomain, 1 used each).
// No payment client here: if a submission ever answered 402, nothing would be paid.
const API = "https://api.nohumans.directory";
const EMAIL = "Fizzl13@protonmail.com";
const cats = await (await fetch(`${API}/v1/categories`)).json();
const names = (Array.isArray(cats) ? cats : cats.categories || cats.results || []).map((c) => (typeof c === "string" ? c : c.category || c.name || c.id)).filter(Boolean);
console.log("categories:", names.join(", "));
const devCat = names.find((n) => /^(dev|developer)/i.test(n)) || names.find((n) => /tool|dev/i.test(n)) || "data.other";
console.log("Doctor category:", devCat);
const TREND = "https://ichimoku-signal.onrender.com/api/trend/BTC-USDT";
const listings = [
  { name: "presign-guard: verdict + plain-language explanation", endpoint_url: "https://presign-guard.onrender.com/v1/check/explain", price_amount: 0.03, chains: ["base"], category: "data.crypto",
    description: "Pre-sign risk verdict (green/orange/red + reason codes) for an EVM transaction, token approval or Permit/Permit2/EIP-3009/Seaport signature, plus a plain-language explanation in English or Dutch." },
  { name: "presign-guard: token verdict", endpoint_url: "https://presign-guard.onrender.com/v1/token", price_amount: 0.01, chains: ["base", "solana"], category: "data.crypto",
    description: "Token verdict (green/orange/red, grade SAFE/CAUTION/RISKY/AVOID, reason codes, one-line summary, market data) for a Solana or EVM token: mint/freeze authority, honeypot, tax, LP lock, liquidity, age, holder concentration." },
  { name: "presign-guard: wallet approval audit", endpoint_url: "https://presign-guard.onrender.com/v1/approvals", price_amount: 0.02, chains: ["base", "solana"], category: "data.crypto",
    description: "Wallet approval audit (green/orange/red, grade, one-line summary): every open ERC-20 allowance of an EVM wallet with who the spender is (flagged, plain wallet, unverified, unlimited) and which ones to revoke." },
  { name: "Ichimoku Signal: 6-indicator confluence", endpoint_url: "https://ichimoku-signal.onrender.com/signals/:pair", price_amount: 0.1, chains: ["base", "solana"], category: "data.crypto", sample_query: TREND,
    description: "Six indicators for a crypto pair in one call (Ichimoku, RSI, MACD, EMA 50/200, Bollinger Bands, volume), each with its values and vote, plus a combined signal and confidence (e.g. 4 of 6 bullish). Any interval, top 200 coins." },
  { name: "Ichimoku Signal: price levels and targets", endpoint_url: "https://ichimoku-signal.onrender.com/levels/:pair", price_amount: 0.05, chains: ["base", "solana"], category: "data.crypto", sample_query: TREND,
    description: "Price levels for a crypto pair: support and resistance, ATR, pivots, Fibonacci and Ichimoku levels, plus a short long/short plan with stop, two targets and risk/reward. Levels, not advice." },
  { name: "Ichimoku Signal: market scan", endpoint_url: "https://ichimoku-signal.onrender.com/scan", price_amount: 0.25, chains: ["base", "solana"], category: "data.crypto", sample_query: TREND,
    description: "Ichimoku signal for 148 top-200 coins in one call, strongest bullish first, with market breadth. &signal=bullish returns only the bullish ones." },
  { name: "x402 Doctor: endpoint diagnosis", endpoint_url: "https://x402-doctor.onrender.com/api/v1/diagnose", price_amount: 0.01, chains: ["base", "solana"], category: devCat,
    description: "Diagnose any x402 endpoint the way a paying agent would: the 402 challenge and envelope, every accepts option (network, asset, amount, payee, EIP-712 domain), the Solana payout account, Bazaar discovery and which wallets can pay. Pass/warn/fail per check. Never pays the endpoint." },
  { name: "x402 Doctor: diagnosis with fixes", endpoint_url: "https://x402-doctor.onrender.com/api/v1/fix", price_amount: 0.05, chains: ["base", "solana"], category: devCat,
    description: "For your own x402 endpoint: the full diagnosis plus the fix for every failing check, with ready-to-paste code for your stack. Never pays the endpoint." },
];
for (const l of listings) {
  const res = await fetch(`${API}/v1/listings`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ...l, price_currency: "USDC", submitter_email: EMAIL }),
  });
  const body = await res.json().catch(() => ({}));
  const keep = { id: body.id ?? body.listing?.id, status: body.status ?? body.listing?.status, allowance: body.submission_allowance, error: body.error, message: body.message, claim: body.claim_token ? "claim_token received (not printed)" : undefined };
  console.log(`${res.status} ${l.endpoint_url} ${JSON.stringify(keep)}`);
}
