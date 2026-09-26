// /setups prototype on live data (free, nothing paid): Ichimoku's own markets, confluence and levels
// modules for every coin in coins.js, one 4h trade plan per coin in the confluence direction, ranked.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
execSync("git clone -q --depth 1 https://github.com/Fizzl13/ichimoku-signal /tmp/ichi && cd /tmp/ichi && npm ci -q --omit=dev --ignore-scripts", { stdio: "inherit" });
const require = createRequire("/tmp/ichi/");
const markets = require("/tmp/ichi/markets.js");
const { levels } = require("/tmp/ichi/levels.js");
const { confluence } = require("/tmp/ichi/indicators.js");
const { COINS } = require("/tmp/ichi/coins.js");
const INTERVAL = "4h", MIN_RR = 1.5, MIN_VOLUME_USD = 250000, TOP = 10;
const r = (n, d = 6) => (Number.isFinite(n) ? Number(n.toPrecision(d)) : null);
const t0 = Date.now();
let running = 0; const queue = []; const slot = () => new Promise((res) => { const go = () => { running++; res(); }; running < 6 ? go() : queue.push(go); });
const done = () => { running--; const n = queue.shift(); if (n) n(); };
const rows = await Promise.all(COINS.map(async (coin) => {
  const pair = `${coin}-USDT`;
  await slot();
  try {
    const found = await markets.findMarket(pair, INTERVAL);
    if (found.status !== "traded") return { pair, skip: found.status };
    const candles = await markets.getMarketCandles(found.market, INTERVAL, 250);
    if (candles.length < 200) return { pair, skip: "not enough history" };
    const lv = levels(candles); const vote = confluence(candles);
    const volumeUsd = candles.slice(-6).reduce((s, c) => s + (c.volume || 0) * c.close, 0);
    return { pair, exchange: found.market.name, lv, vote, volumeUsd };
  } catch (e) { return { pair, skip: "market data unavailable" }; } finally { done(); }
}));
const ok = rows.filter((x) => !x.skip);
const setups = [];
for (const x of ok) {
  if (x.vote.signal === "neutral" || !x.lv) continue;
  if (x.volumeUsd < MIN_VOLUME_USD) continue;
  const dir = x.vote.signal === "bullish" ? "long" : "short";
  const p = x.lv.plans[dir];
  if (!(p.risk_reward_1 >= MIN_RR)) continue;
  const rank = Math.abs(x.vote.score) * Math.min(p.risk_reward_1, 3) / 3;
  setups.push({ rank_score: r(rank, 3), pair: x.pair, direction: dir, confidence: x.vote.confidence, signal_from: x.vote.summary,
    entry: p.entry, stop: p.stop, target_1: p.target_1, target_2: p.target_2, risk_reward_1: p.risk_reward_1, risk_reward_2: p.risk_reward_2,
    stop_basis: p.stop_basis, obstacle_before_target: p.obstacle_before_target, atr_percent: x.lv.atr_percent, volume_24h_usd: Math.round(x.volumeUsd), exchange: x.exchange });
}
setups.sort((a, b) => b.rank_score - a.rank_score);
const out = {
  interval: INTERVAL, timestamp: new Date().toISOString(), coins_scanned: ok.length,
  filters: { min_risk_reward: MIN_RR, min_volume_24h_usd: MIN_VOLUME_USD, direction: "both", top: TOP },
  setups_found: setups.length,
  summary: { long: setups.filter((s) => s.direction === "long").length, short: setups.filter((s) => s.direction === "short").length,
    left_out: { neutral: ok.filter((x) => x.vote.signal === "neutral").length, low_volume: ok.filter((x) => x.vote.signal !== "neutral" && x.volumeUsd < MIN_VOLUME_USD).length } },
  setups: setups.slice(0, TOP).map((s, i) => ({ rank: i + 1, ...s })),
  note: "Setups computed from price history, not trade advice or a prediction.",
};
console.log(`took ${Date.now() - t0} ms, ${rows.length - ok.length} coins skipped`);
console.log("=====JSON=====");
console.log(JSON.stringify(out, null, 2));
