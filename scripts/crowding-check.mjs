// Crowding check: Edge Agents derivatives data + Ichimoku Signal confluence in one read.
//
// An agent pays per call with x402 (USDC on Base):
//   1. Edge Agents perp funding rates (Binance, Bybit, OKX)        $0.01
//   2. Edge Agents CFTC leveraged-fund positioning (CME, weekly)    $0.01
//   3. Ichimoku Signal confluence on 4h and 1d (two calls)          $0.20
// and combines them into a short read, e.g. "crowded long + price below the cloud = caution".
// Every input keeps its own timestamp: funding is minutes old, positioning is weekly.
//
// Usage (from the repository root, after npm install):
//   node examples/crowding-check/crowding-check.mjs BTC --dry-run   # prices only, pays nothing
//   EVM_PRIVATE_KEY=0x... node examples/crowding-check/crowding-check.mjs BTC
//   EVM_PRIVATE_KEY=0x... node examples/crowding-check/crowding-check.mjs ETH --json
//
// Use a dedicated wallet with a few dollars of USDC on Base; no ETH is needed.
// Not trade advice: this is an example of combining two x402 services.

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = "eip155:8453";
const EDGE = "https://pay.edge-agents.ai/v1/services";
const ICHIMOKU = (process.env.SIGNAL_URL || "https://ichimoku-signal.onrender.com").replace(/\/$/, "");
const INTERVALS = ["4h", "1d"];

// Thresholds for the read. Funding is per funding period (usually 8h); 0.01% is the common baseline.
export const ELEVATED_FUNDING = 0.01; // percent
export const CROWDED_NET = 0.25; // net position as a share of gross (long + short) for leveraged funds

const args = process.argv.slice(2);
const asset = (args.find((a) => !a.startsWith("--")) || "BTC").toUpperCase();
const dryRun = args.includes("--dry-run");
const asJson = args.includes("--json");

// ---------------------------------------------------------------- reading the inputs

// Average funding across venues that answered; withheld venues are listed, never guessed.
export function readFunding(data, asset) {
  const row = (data?.assets || []).find((a) => String(a.asset).toUpperCase() === asset);
  if (!row) return { available: false, reason: `no ${asset} row` };
  const venues = row.venues || [];
  const live = venues.filter((v) => v.status === "available" && Number.isFinite(Number(v.fundingRatePercent)));
  if (!live.length) return { available: false, reason: "no venue available" };
  const rates = live.map((v) => Number(v.fundingRatePercent));
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  const allPositive = rates.every((r) => r > 0);
  const allNegative = rates.every((r) => r < 0);
  return {
    available: true,
    averagePercent: avg,
    venues: live.map((v) => ({ venue: v.venue, ratePercent: Number(v.fundingRatePercent), nextFundingTime: v.nextFundingTime })),
    withheld: venues.filter((v) => !live.includes(v)).map((v) => v.venue),
    lean: allPositive && avg >= ELEVATED_FUNDING ? "longs_paying" : allNegative && avg <= -ELEVATED_FUNDING ? "shorts_paying" : "balanced",
  };
}

// Leveraged-fund positioning. The field names are found by shape (long/short numbers under a
// leveraged-funds object), so small changes in the response do not break the read.
export function readPositioning(data) {
  const found = findLongShort(data);
  if (!found) return { available: false, reason: "no long/short figures found" };
  const { long, short, path } = found;
  const gross = long + short;
  const netShare = gross > 0 ? (long - short) / gross : 0;
  return {
    available: true,
    long,
    short,
    netShare,
    reportDate: findDate(data),
    source: path,
    lean: netShare >= CROWDED_NET ? "crowded_long" : netShare <= -CROWDED_NET ? "crowded_short" : "balanced",
  };
}

function findLongShort(node, path = "", preferLev = false) {
  if (!node || typeof node !== "object") return null;
  const lev = preferLev || /lev/i.test(path);
  const keys = Object.keys(node);
  const num = (re) => {
    const k = keys.find((key) => re.test(key) && !/change|chg|delta|pct|percent/i.test(key) && Number.isFinite(Number(node[key])));
    return k === undefined ? undefined : Number(node[k]);
  };
  const long = num(/long/i);
  const short = num(/short/i);
  if (lev && long !== undefined && short !== undefined) return { long, short, path: path || "(root)" };
  let fallback = null;
  for (const k of keys) {
    const hit = findLongShort(node[k], path ? `${path}.${k}` : k, lev);
    if (hit && /lev/i.test(hit.path)) return hit;
    fallback = fallback || hit;
  }
  if (fallback) return fallback;
  return long !== undefined && short !== undefined ? { long, short, path: path || "(root)" } : null;
}

function findDate(node) {
  if (!node || typeof node !== "object") return null;
  for (const [k, v] of Object.entries(node)) {
    if (/report.*date|as.?of|date/i.test(k) && typeof v === "string") return v;
  }
  for (const v of Object.values(node)) {
    const d = findDate(v);
    if (d) return d;
  }
  return null;
}

export function readCloud(signal) {
  const ichimoku = signal?.indicators?.ichimoku || {};
  return {
    interval: signal?.interval,
    timestamp: signal?.timestamp,
    price: signal?.price,
    cloud: ichimoku.cloud_position || "unknown",
    confluence: signal?.signal,
    summary: signal?.summary,
  };
}

// ---------------------------------------------------------------- the read

export function combine({ funding, positioning, clouds }) {
  const below = clouds.filter((c) => c.cloud === "below_cloud").length;
  const above = clouds.filter((c) => c.cloud === "above_cloud").length;
  const trend = below === clouds.length ? "bearish" : above === clouds.length ? "bullish" : "mixed";

  const longSigns = [funding.lean === "longs_paying" && "funding positive across venues", positioning.lean === "crowded_long" && "leveraged funds heavily net long"].filter(Boolean);
  const shortSigns = [funding.lean === "shorts_paying" && "funding negative across venues", positioning.lean === "crowded_short" && "leveraged funds heavily net short"].filter(Boolean);
  // Funding leads: leveraged funds on CME are often net short by structure (basis trades), so
  // positioning only adds weight when it agrees with funding, and never sets the crowd on its own.
  const crowd = funding.lean === "longs_paying" && positioning.lean !== "crowded_short" ? "long" : funding.lean === "shorts_paying" && positioning.lean !== "crowded_long" ? "short" : "none";
  const where = clouds.map((c) => `${c.cloud.replace("_", " ")} on ${c.interval}`).join(", ");

  if (crowd === "long" && trend === "bearish") return { verdict: "caution", read: `Crowded long (${longSigns.join(", ")}) while price is ${where}: longs are leaning against a bearish trend.` };
  if (crowd === "short" && trend === "bullish") return { verdict: "squeeze_risk", read: `Crowded short (${shortSigns.join(", ")}) while price is ${where}: shorts are leaning against a bullish trend.` };
  if (crowd === "long" && trend === "bullish") return { verdict: "crowded_trend", read: `Trend and crowd agree (bullish; ${longSigns.join(", ")}): the trend is intact but positioning is stretched.` };
  if (crowd === "short" && trend === "bearish") return { verdict: "crowded_trend", read: `Trend and crowd agree (bearish; ${shortSigns.join(", ")}): the trend is intact but positioning is stretched.` };
  return { verdict: "no_crowding_signal", read: `No clear crowding against the trend (price is ${where}).` };
}

// ---------------------------------------------------------------- calls

function preferBase(_version, requirements) {
  const option = requirements.find((r) => r.network === BASE);
  if (!option) throw new Error(`no Base option offered (networks: ${requirements.map((r) => r.network).join(", ")})`);
  return option;
}

async function priceOf(url) {
  const res = await fetch(url);
  if (res.status !== 402) return `HTTP ${res.status} (expected 402)`;
  const header = res.headers.get("payment-required");
  const challenge = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json();
  const base = (challenge.accepts || []).find((a) => a.network === BASE);
  return base ? `$${Number(base.amount) / 1e6} USDC on Base` : "no Base option";
}

async function main() {
  const positioningPath = `${asset.toLowerCase()}-cftc-leveraged-fund-positioning`;
  if (!["BTC", "ETH"].includes(asset)) throw new Error("positioning is available for BTC and ETH");
  const urls = {
    funding: `${EDGE}/perp-funding-rates`,
    positioning: `${EDGE}/${positioningPath}`,
    ...Object.fromEntries(INTERVALS.map((i) => [`confluence_${i}`, `${ICHIMOKU}/signals/${asset}-USDT?interval=${i}`])),
  };

  if (dryRun) {
    for (const [name, url] of Object.entries(urls)) console.log(`${name.padEnd(15)} ${await priceOf(url)}  ${url}`);
    return;
  }

  const key = process.env.EVM_PRIVATE_KEY;
  if (!key) throw new Error("set EVM_PRIVATE_KEY (a dedicated wallet with USDC on Base), or use --dry-run");
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const client = new x402Client(preferBase).register(BASE, new ExactEvmScheme(account)).setSpendControls({ maxAmountPerPayment: "$0.10" });
  const pay = wrapFetchWithPayment(fetch, client);

  const receipts = [];
  const get = async (name, url) => {
    const res = await pay(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const header = res.headers.get("payment-response");
    if (header) receipts.push({ call: name, tx: decodePaymentResponseHeader(header).transaction });
    return res.json();
  };

  const [fundingRaw, positioningRaw, ...signals] = await Promise.all([
    get("funding", urls.funding),
    get("positioning", urls.positioning),
    ...INTERVALS.map((i) => get(`confluence_${i}`, urls[`confluence_${i}`])),
  ]);

  const funding = readFunding(fundingRaw, asset);
  const positioning = readPositioning(positioningRaw);
  const clouds = signals.map(readCloud);
  const result = { asset, ...combine({ funding, positioning, clouds }), inputs: { funding, positioning, clouds }, receipts, note: "Example of combining two x402 services; not trade advice." };

  if (asJson) return console.log(JSON.stringify(result, null, 2));
  const pct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(4)}%`;
  console.log(`\n${asset}: ${result.verdict.toUpperCase().replace(/_/g, " ")}\n${result.read}\n`);
  console.log(funding.available
    ? `Funding     avg ${pct(funding.averagePercent)} (${funding.venues.map((v) => `${v.venue} ${pct(v.ratePercent)}`).join(", ")})${funding.withheld.length ? `; withheld: ${funding.withheld.join(", ")}` : ""}  [live, next funding ${funding.venues[0]?.nextFundingTime || "?"}]`
    : `Funding     unavailable (${funding.reason})`);
  console.log(positioning.available
    ? `Positioning leveraged funds net ${(positioning.netShare * 100).toFixed(0)}% of gross (long ${positioning.long}, short ${positioning.short})  [weekly CFTC, report ${positioning.reportDate || "date not given"}]`
    : `Positioning unavailable (${positioning.reason})`);
  for (const c of clouds) console.log(`Ichimoku    ${c.interval}: ${c.cloud.replace("_", " ")}, confluence ${c.confluence} (${c.summary})  [${c.timestamp}]`);
  console.log(`\nPaid: ${receipts.map((r) => `${r.call} ${r.tx}`).join(" · ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
