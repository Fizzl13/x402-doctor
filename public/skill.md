---
name: x402-doctor
description: Check x402 endpoints the way a paying agent would: is it safe to pay, what's broken, and how to fix it. Free quick check; paid preflight, diagnosis and fixes via x402 (Base or Solana).
---

# x402 Doctor

Checks x402 endpoints the way a paying agent would. **Before you pay an endpoint you don't know, ask the Doctor**: for $0.001 the preflight says `go`, `caution` or `no_go`, with the cheapest payable option. It also diagnoses what's broken on an endpoint and hands out the fix.

Website: https://x402-doctor.fizzl.eu · Prices and schemas: https://x402-doctor.fizzl.eu/openapi.json

## Use it as an MCP server (simplest)

Add the remote MCP server `https://x402-doctor.fizzl.eu/mcp` (Streamable HTTP) to Claude, Cursor or another MCP client. In Claude Code: `claude mcp add --transport http x402-doctor https://x402-doctor.fizzl.eu/mcp`.

| Tool | Price | What it does |
|---|---|---|
| `x402_quick_check` | free, 10/hour | pass/warn/fail, the number of problems and the top three |
| `x402_preflight` | $0.001 | go/caution/no_go before paying an endpoint |
| `x402_preflight_batch` | $0.005 | The preflight for up to 10 endpoints |
| `x402_preflight_deep` | $0.01 | The preflight plus diagnosis, history, seller and domain checks |
| `x402_diagnose` | $0.01 | Every check with a fix hint |
| `x402_fix` | $0.05 | The code changes for your stack |

The free tools work right away. The paid tools ask for an x402 payment inside the call (see Paying).

## Or call the HTTP API

| Endpoint | Price (USDC) | What it returns |
|---|---|---|
| `GET /api/v1/preflight?url=<endpoint>&max_usd=0.05` | $0.001 | `verdict` (go / caution / no_go), `safe_to_pay`, the recommended option |
| `GET /api/v1/preflight/batch?url=<a>&url=<b>&max_usd=0.05` | $0.005 | The same for up to 10 endpoints |
| `GET /api/v1/preflight/deep?url=<endpoint>&max_usd=0.5` | $0.01 | Preflight plus diagnosis, history and seller checks |
| `GET /api/v1/diagnose?url=<endpoint>&method=GET` | $0.01 | The full diagnosis |
| `GET /api/v1/fix?url=<endpoint>&method=GET` | $0.05 | The fixes, as code |

Examples:

- Before paying an unknown API: `GET https://x402-doctor.fizzl.eu/api/v1/preflight?url=https%3A%2F%2Fexample.com%2Fpaid&max_usd=0.05` (max $0.001). Pay the endpoint only on `go`; on `caution`, tell your owner why.
- "Why does my x402 endpoint fail?": `GET https://x402-doctor.fizzl.eu/api/v1/diagnose?url=<your endpoint>` (max $0.01)

## Free

- The MCP tool `x402_quick_check` (10 calls an hour).
- The website: paste an endpoint at https://x402-doctor.fizzl.eu for the full report in the browser.
- `GET /api/trust?url=<resource>`: what other agents reported after paying that resource (30 a minute).
- After paying any x402 endpoint: `POST /api/settlement` with `{"header": "<the PAYMENT-RESPONSE header>"}` (or the MCP tool `check_payment_proof`) shows the on-chain transaction, network, payer and the USDC that moved. Web page: https://x402-doctor.fizzl.eu/settlement

## Paying

Paid calls use **x402**: the first request answers `402 Payment Required` with the price, your x402 client pays in USDC and retries. You need one of:

- **The Fizzl Agent Wallet** (recommended): your owner's spending limits, approval on their phone above them, every signature checked first, and a receipt for each purchase. Set it up by following https://wallet.fizzl.eu/skill.md, then call these endpoints with `pay_x402`.
- **Any other x402 client** with its own wallet (for example `@x402/fetch`).

Rules for you, the agent:
- Never ask your owner to paste a private key or seed phrase into the chat.
- Always cap the price (`max_price_usd` with the Fizzl wallet) at the price listed here.
- Pay only for what the task needs; use the free calls first when they are enough.

## Feedback

Found a bug or missing something? `POST https://x402-doctor.fizzl.eu/feedback` with `{"type": "bug" | "feature" | "other", "message": "…"}` (free), or the MCP tool `feedback`.
