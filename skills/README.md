# x402 Doctor plugin

Checks an x402 or MPP paid API before an agent pays it, and helps a seller fix their own paid endpoint. This folder is the plugin: two skills and x402 Doctor's remote MCP server.

## What's in it

- **`x402-preflight`** (skill): before paying an HTTP 402 endpoint, get its free 30-day track record, then a go / caution / no_go verdict with the reasons and the payment option that will settle.
- **`x402-seller-check`** (skill): check your own paid endpoint the way buyers and registries see it, with a fix hint per problem.
- **MCP server** `x402-doctor` at `https://x402-doctor.fizzl.eu/mcp` (Streamable HTTP, no sign-in). Every tool has a title and a `readOnlyHint` or `destructiveHint`.

## What it runs, sends and fetches

- The skills run `curl` against `https://x402-doctor.fizzl.eu` only. The MCP server is the same service.
- Sent: what you ask to be checked, such as an endpoint URL and method, a payee or wallet address, a payment proof or receipt, and feedback you choose to send.
- Fetched: x402 Doctor's answer (verdicts, reasons, track records, fix hints). x402 Doctor itself reads only the endpoint's 402 challenge, its public listings and its history.
- The free checks cost nothing. Paid checks ($0.001 for a verdict, $0.05 for a code fix, $0.25 for a delivery check) return an HTTP 402 that your own x402 client pays, after you agree. The plugin holds no keys, never asks for a private key or seed phrase, and never pays by itself.
- No hooks, no local programs, no files written.

## Data

There are no accounts. A request and its answer are kept at most 10 minutes in memory; a short usage record per call (time, route, status, payment, a visitor code made from the IP address) is kept at most 2 years. Details: [privacy statement](https://fizzl.eu/privacy/). Questions or security reports: Fizzl13@protonmail.com.

## Try it

- "Is https://ichimoku-signal.fizzl.eu/api/v1/signal?coin=BTC safe to pay?"
- "Check my x402 endpoint https://example.com/api/paid and tell me what to fix."
- "Which x402 facilitators are up right now?"

Source and license (AGPL-3.0): [Fizzl13/x402-doctor](https://github.com/Fizzl13/x402-doctor).
