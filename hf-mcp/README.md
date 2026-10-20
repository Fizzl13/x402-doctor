---
title: x402 Doctor
emoji: 🩺
colorFrom: blue
colorTo: green
sdk: gradio
sdk_version: 6.25.0
app_file: app.py
pinned: false
license: mit
short_description: Check x402 paid APIs before an AI agent pays (MCP)
tags:
  - mcp-server
  - x402
  - agents
  - payments
  - ai-agents
---

# x402 Doctor

Check paid APIs (x402 and MPP) before an AI agent pays them. Free and read-only: this Space never pays, signs or holds
a key. It calls the public API of [x402 Doctor](https://x402-doctor.fizzl.eu).

## Tools (also an MCP server)

| Tool | What it does |
|---|---|
| `check_x402_endpoint(url, method, body)` | Triggers the endpoint's 402 challenge once and checks it the way a paying agent meets it: protocol version, payment options (network, amount, asset, payout address), the resource URL, sanctions and burn addresses, the price against the OpenAPI document, and which wallets could pay. Every problem comes with its fix. `body` is an optional example JSON request body for a POST route that checks its input before the 402. |
| `trust_record(url)` | The daily track record of an endpoint listed in the CDP Bazaar, Circle's Agent Marketplace, GoPlausible's discovery list or the MPP directory, or added by its seller: days payable, the latest verdict and reasons, price and networks, and what happened when Doctor bought it in its weekly spot-buy sample. |
| `add_to_trust_index(url)` | Your own endpoint isn't listed anywhere yet? Doctor checks that it answers 402 with a payment challenge, and the next daily scan starts its track record. At most 25 endpoints per host. |
| `x402_market_health()` | The latest daily check of every listed endpoint: shares payable, clean, with a caution and not payable, the most common reasons a payment would fail, and the networks. |

## Use it from an MCP client

- **Hugging Face:** add `x402Fizzl/x402-doctor` under [Settings → MCP](https://huggingface.co/settings/mcp), then use the tools from any client connected to the Hugging Face MCP server.
- **Any MCP client** (Claude, Cursor, …): connect to `https://x402fizzl-x402-doctor.hf.space/gradio_api/mcp/` (streamable HTTP).

## Paying, and more checks

For a go / caution / no_go verdict with your budget before paying, agents buy x402 Doctor's preflight ($0.001 over
x402) at `https://x402-doctor.fizzl.eu/api/v1/preflight`, or use its own MCP server and skill. The daily data behind
`trust_record` and `x402_market_health` is open: the [Trust Index](https://x402-doctor.fizzl.eu/trust) and the
[dataset on Hugging Face](https://huggingface.co/datasets/x402Fizzl/x402-trust-index).

Source: [Fizzl13/x402-doctor](https://github.com/Fizzl13/x402-doctor/tree/master/hf-mcp). By Fizzl, fizzl.eu.
