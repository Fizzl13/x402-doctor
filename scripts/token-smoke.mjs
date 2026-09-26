// Re-run after the description rewrites: where do our endpoints rank on nohumans.directory for plain-language needs they answer? (free, read-only)
const API = "https://api.nohumans.directory";
const OURS = /presign-guard|ichimoku-signal|x402-doctor|smartcontractexplainer/;
const needs = [
  ["presign", "is this token safe to buy"],
  ["presign", "check a token for honeypot or rug pull before buying"],
  ["presign", "check a token approval before signing it"],
  ["presign", "is this transaction or signature safe to sign"],
  ["presign", "which token approvals on my wallet should I revoke"],
  ["presign", "check if a wallet address is sanctioned or a scammer"],
  ["ichimoku", "crypto trend signal for BTC bullish or bearish"],
  ["ichimoku", "technical analysis indicators for a crypto pair RSI MACD"],
  ["ichimoku", "support and resistance levels stop loss take profit for crypto"],
  ["ichimoku", "which crypto coins are bullish right now market scan"],
  ["doctor", "check an x402 endpoint before paying it"],
  ["doctor", "why does my x402 endpoint fail payment debug"],
  ["doctor", "x402 endpoint reliability uptime data"],
];
for (const [svc, q] of needs) {
  const d = await (await fetch(`${API}/v1/discover?q=${encodeURIComponent(q)}&limit=20`)).json();
  const res = d.results || [];
  const hits = res.map((r, i) => [i + 1, r]).filter(([, r]) => OURS.test(r.endpoint_url));
  const top = res.slice(0, 3).map((r) => `${r.name.slice(0, 38)} $${r.price_amount}`).join(" ; ");
  console.log(`[${svc}] "${q}" → ours: ${hits.length ? hits.map(([i, r]) => `#${i} ${r.endpoint_url.replace(/^https:\/\//, "")}`).join(", ") : "not in top 20"}\n     top3: ${top}`);
}
