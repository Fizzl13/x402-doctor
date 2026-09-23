# x402 Doctor

Diagnoses why an x402-payable endpoint's payment flow is broken, without needing a funded wallet.

Paste a URL (web app) or run `x402-doctor <url>` (CLI, CI) and get back exactly which check failed, why, and how
to fix it. Every check traces back to a real bug hit while shipping
[PlainText](https://smartcontractexplainer.onrender.com) and
[Ichimoku Signal](https://ichimoku-signal.onrender.com).

## What it checks

| Group | Check | Catches |
|-------|-------|---------|
| 402 challenge | `returns-402` | No 402 for GET or POST (tries both, or `--method`) |
| | `protocol-version`, `challenge-header` | v1 vs v2, missing `x402Version`, challenge in the wrong header, undecodable header |
| | `envelope-body-mirror` | Header-only challenge (`@x402/express` sends `{}`), header and body disagreeing |
| Payment options | `accepts[i]-scheme`, `-network` | Missing scheme; legacy names like `base` / `solana:mainnet` instead of CAIP-2 |
| | `accepts[i]-payto`, `-asset` | Invalid EVM/Solana addresses; asset that is not USDC, or USDC of another network (e.g. Base Sepolia USDC on Base) |
| | `accepts[i]-amount` | Decimal dollar amounts (`"0.02"`) instead of atomic units, zero or non-integer amounts |
| | `accepts[i]-extra` | Solana without `extra.feePayer` (clients throw "feePayer is required"), EVM without the EIP-712 `name`/`version` |
| Resource | `resource-url` | `http://` resource URL on an `https://` endpoint (Express behind a TLS proxy without `trust proxy`) |
| | `resource-metadata` | Missing description / mimeType |
| Settlement | `solana-payout-account` | Solana payout wallet without a token account for the asset: every settlement fails on-chain |
| | `solana-wallets` | Solana settled by PayAI, which rejects Phantom (Lighthouse instructions before the transfer) |
| Discovery | `bazaar`, `bazaar-output` | Missing or invalid Bazaar declaration, output example not matching its schema |
| | `bazaar-replay` | The declared example request not answering 402, so the Bazaar cannot index it |
| | `openapi-present`, `openapi-title`, `openapi-guidance` | Missing `/openapi.json`, `info.title`, `info.x-guidance` |
| Browser | `paywall` | Browser paywall in testnet mode on a mainnet endpoint (`@x402/paywall` defaults to testnet) |

Statuses: `pass`, `warn` (works, but something is off), `fail` (payments fail or it is not valid x402), `info`.

## Web app

```bash
npm install
npm start          # http://localhost:3001
```

Reports are shareable: `https://<host>/?url=<endpoint>&method=GET` runs the diagnosis on load.

API: `POST /api/diagnose` with `{ "url": "...", "method": "GET" | "POST" }` (method optional) returns
`{ url, method, overall, checks[], challenge }`. Rate-limited to 10 diagnoses per minute per IP.

## Paid API for agents (x402)

`GET /api/v1/diagnose?url=<endpoint>&method=GET|POST` returns the same report, **$0.01 USDC per call** on Base or
Solana via x402, with no rate limit. It is meant for agents and CI pipelines; the web page stays free.

- Unpaid requests get the x402 challenge (`PAYMENT-REQUIRED` header, mirrored in the body) with a Bazaar input and
  output schema.
- Invalid input (bad URL, non-http(s), unknown method) gets a 400 **before** payment. The bare route without `url`
  answers 402, so indexers such as x402scan can register it. Paying without a `url` returns a 400.
- The x402 middleware settles only after a 2xx response, so a diagnosis that errors out is never charged.
- Discovery: `/openapi.json` (with `x-payment-info`) and `/.well-known/x402`.

```bash
# pay-per-call from Node with @x402/fetch
const paidFetch = wrapFetchWithPayment(fetch, client);   // client with an EVM or SVM signer
const report = await (await paidFetch("https://<host>/api/v1/diagnose?url=https://api.example.com/paid")).json();
```

## CLI

```bash
npx github:Fizzl13/x402-doctor https://api.example.com/paid
npx github:Fizzl13/x402-doctor https://api.example.com/paid --method POST --json
```

Exit code `0` on pass/warn, `1` when a check fails (or on warnings with `--strict`), `2` on usage errors.
The CLI can diagnose `localhost`, so you can run it against a dev server.

In GitHub Actions:

```yaml
- run: npx -y github:Fizzl13/x402-doctor https://your-api.example.com/paid
```

## Configuration

| Variable | Purpose |
|----------|---------|
| `PORT` | Web server port (default `3001`) |
| `SOLANA_RPC_URL` | RPC for the Solana payout-account check (default: public mainnet RPC, which rate-limits) |
| `AGENT_PAYOUT_WALLET` | Base address that receives paid-API payments (or `DOCTOR_PAYOUT_WALLET`) |
| `AGENT_PAYOUT_WALLET_SOLANA` | Solana address that receives paid-API payments (or `DOCTOR_PAYOUT_WALLET_SOLANA`); needs a USDC token account |
| `DOCTOR_PRICE` | Price per paid diagnosis (default `$0.01`) |
| `FACILITATOR_URL` | x402 facilitator (default PayAI, `https://facilitator.payai.network`) |

Without either payout wallet the paid route answers 503 and the rest of the app works as before.

## Safety

The web app fetches user-submitted URLs server-side:

- Every connection is checked against private and reserved ranges (RFC 1918, loopback, link-local and cloud
  metadata, CGNAT, IPv6 ULA/link-local, IPv4-mapped IPv6 in any notation) **at connect time**, so DNS rebinding
  cannot slip past a separate lookup. Redirects are followed manually and each hop is re-checked.
- Responses are capped at 2 MB and every request times out after 8 s.
- `/api/diagnose` (free) is rate-limited per IP; `/api/v1/diagnose` is paid per call and uses the same guards.
- Everything taken from the diagnosed endpoint is rendered as text, never as HTML.

It never pays the endpoint it diagnoses: no wallet, no signatures, zero financial risk. A paid probe (sign and settle one minimal payment
to trace verify/settle failures) is deliberately out of scope here.

## Project structure

```
server.js              Express app: /api/diagnose (free), paid API, /openapi.json, /.well-known/x402, static frontend
lib/paid-api.js        GET /api/v1/diagnose behind x402 (Base + Solana USDC via PayAI)
lib/diagnose.js        The checks
lib/networks.js        Known networks, USDC per network, address validation
lib/safe-fetch.js      SSRF-safe fetch (connect-time IP check, redirects, size cap, timeout)
bin/x402-doctor.js     CLI
public/index.html      Frontend
test/                  node:test suites (fixture x402 servers, SSRF, CLI, API)
```

## Tests

```bash
npm test
```

The suites run the doctor against local fixture servers: a healthy v2 service (Base + Solana, Bazaar, OpenAPI,
mainnet paywall) and a broken one that reproduces the real bugs above, plus SSRF, size-cap, API and CLI tests.
