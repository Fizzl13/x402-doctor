---
name: ichimoku-signal
title: "Ichimoku Signal"
description: "Is a crypto pair bullish, bearish or neutral right now? Ichimoku Cloud trend signal, 6-indicator confluence, support/resistance levels with stop and targets, and a 148-coin market scan. Top 200 coins, any interval."
use_case: "Use when an agent needs a trend read for BTC, ETH, SOL or any top-200 coin: bullish/bearish/neutral, indicator confluence (RSI, MACD, EMA, Bollinger), stop and take-profit levels, or which coins are bullish right now."
category: finance
service_url: https://ichimoku-signal.onrender.com
version: v1
openapi:
  path: openapi.json
---

Crypto technical signals for AI agents, paid per call with x402 on Base or Solana. Candles come live from Binance.US, then Kraken, Gate or MEXC, so the top 200 coins are covered on any interval from 1m to 1M.

- **`GET /signal/{pair}`** ($0.02): the Ichimoku Cloud signal: bullish, bearish or neutral, with the cloud position, the tenkan/kijun cross, the price and all five Ichimoku lines.
- **`GET /signals/{pair}`** ($0.10): six indicators in one call (Ichimoku, RSI, MACD, EMA 50/200, Bollinger Bands, volume), each with its vote, plus a combined signal and confidence.
- **`GET /levels/{pair}`** ($0.05): support and resistance, ATR, pivots, Fibonacci and Ichimoku levels, plus a long and a short plan with stop, two targets and risk/reward. Levels, not advice.
- **`GET /scan`** ($0.25): the Ichimoku signal for 148 coins at once, strongest bullish first, with market breadth; `&signal=bullish` returns only the bullish ones.

A free daily trend per pair is at `GET /api/trend/{pair}` (no payment; rate-limited per IP), and an MCP server is at `https://ichimoku-signal.onrender.com/mcp`.

## Spend-aware usage

- **Try the free daily trend first** (`/api/trend/{pair}`): if the daily direction already answers the question, no paid call is needed.
- **One `/scan` instead of many `/signal` calls** when comparing more than about ten coins.
- **Match the interval to the decision:** `4h` or `1d` for positioning, shorter intervals only for intraday timing. A signal does not change between candle closes, so do not poll faster than the interval.
- **Signals are technical indicators, not financial advice.**
