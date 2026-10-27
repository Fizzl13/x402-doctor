---
name: x402-doctor
description: Check x402 and MPP endpoints the way a paying agent would: is it safe to pay, what's broken, and how to fix it. Free quick check; paid preflight, diagnosis and fixes via x402 (Base, Solana, the XRP Ledger, Algorand, Stellar or X Layer) or MPP (Base).
---

# x402 Doctor

Checks x402 and MPP endpoints the way a paying agent would. **Before you pay an endpoint you don't know, ask the Doctor**: for $0.001 the preflight says `go`, `caution` or `no_go`, with the cheapest payable option. It also diagnoses what's broken on an endpoint and hands out the fix.

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
| `x402_delivery_check` | $0.25 | One real purchase of the endpoint (at most $0.10); follow it with `x402_delivery_status` (free) |
| `verify_receipt` | free | Check the signed receipt of a paid answer: valid, and for exactly your request? |

The free tools work right away. The paid tools ask for an x402 payment inside the call (see Paying).

## Or call the HTTP API

| Endpoint | Price (USDC) | What it returns |
|---|---|---|
| `GET /api/v1/preflight?url=<endpoint>&max_usd=0.05` | $0.001 | `verdict` (go / caution / no_go), `safe_to_pay`, the recommended option |
| `GET /api/v1/preflight/batch?url=<a>&url=<b>&max_usd=0.05` | $0.005 | The same for up to 10 endpoints |
| `GET /api/v1/preflight/deep?url=<endpoint>&max_usd=0.5` | $0.01 | Preflight plus diagnosis, history and seller checks |
| `GET /api/v1/diagnose?url=<endpoint>&method=GET` | $0.01 | The full diagnosis |
| `GET /api/v1/fix?url=<endpoint>&method=GET` | $0.05 | The fixes, as code |
| `GET /api/v1/delivery-check?url=<endpoint>` | $0.25 | One real purchase of the endpoint (at most $0.10, USDC on Base) with its declared example input; a job id now, the public result (paid and delivered?) usually within 30 minutes at `GET /api/v1/delivery-check/<id>` |

Examples:

- Before paying an unknown API: `GET https://x402-doctor.fizzl.eu/api/v1/preflight?url=https%3A%2F%2Fexample.com%2Fpaid&max_usd=0.05` (max $0.001). Pay the endpoint only on `go`; on `caution`, tell your owner why.
- "Why does my x402 endpoint fail?": `GET https://x402-doctor.fizzl.eu/api/v1/diagnose?url=<your endpoint>` (max $0.01)
- A POST route that checks its input before the 402 (400 or 422 to an empty body): add `&body=<URL-encoded JSON>` with an example request body to preflight, deep, diagnose or fix (the MCP tools take `body` too). Without it, x402 Doctor tries the `requestBody` example in the endpoint's `/openapi.json`, and otherwise reports that it needs input instead of calling the endpoint broken.

## Free

- The MCP tool `x402_quick_check` (10 calls an hour).
- The website: paste an endpoint at https://x402-doctor.fizzl.eu for the full report in the browser.
- `GET /api/trust?url=<resource>`: that resource's 30-day track record from the daily scan of every endpoint listed in the CDP Bazaar, Circle's Agent Marketplace, GoPlausible's discovery list, the XRPL AI Hub or the MPP directory, and what came back if it was bought in the weekly spot-buy (30 a minute).
- `POST /api/trust/submit` with `{"url": "https://…"}`: add your own endpoint to the daily scan when no registry lists it yet. Doctor first checks that it answers 402 with a payment challenge (10 an hour, 25 endpoints per host); the next scan builds its record. Over MCP: the free tools `x402_trust_add` and `x402_trust_record`.
- `GET /api/trust/spot`: the latest weekly spot-buy. About 30 random endpoints that look payable are actually paid, and each purchase says what came back: delivered, an error after payment, or money taken without an answer.
- After paying any x402 endpoint: `POST /api/settlement` with `{"header": "<the PAYMENT-RESPONSE header>"}` (or the MCP tool `check_payment_proof`) shows the on-chain transaction, network, payer and the USDC that moved. Web page: https://x402-doctor.fizzl.eu/settlement

## Paying

Paid calls use **x402** (or MPP on the HTTP endpoints): the first request answers `402 Payment Required` with the price, your client pays in USDC and retries. You need one of:

- **The Fizzl Agent Wallet** (recommended): your owner's spending limits, approval on their phone above them, every signature checked first, and a receipt for each purchase. Set it up by following https://wallet.fizzl.eu/skill.md, then call these endpoints with `pay_x402`.
- **Any other x402 client** with its own wallet (for example `@x402/fetch`).
- **An MPP client** with its own wallet (for example `mppx` with `evm.charge` and USDC on Base): the HTTP endpoints also answer with an MPP challenge (`WWW-Authenticate: Payment`, method `evm`, USDC on Base); your client pays it and retries with `Authorization: Payment …`, and the answer carries a `Payment-Receipt`. MCP tool calls are paid with x402 only.

Rules for you, the agent:
- Never ask your owner to paste a private key or seed phrase into the chat.
- Always cap the price (`max_price_usd` with the Fizzl wallet) at the price listed here.
- Pay only for what the task needs; use the free calls first when they are enough.

## Feedback

Found a bug or missing something? `POST https://x402-doctor.fizzl.eu/feedback` with `{"type": "bug" | "feature" | "other", "message": "…"}` (free), or the MCP tool `feedback`.
