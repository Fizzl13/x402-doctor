# x402 Doctor

Diagnoses why an x402-payable endpoint's payment flow is broken, without needing a funded wallet.

Paste a URL (web app) or run `x402-doctor <url>` (CLI, CI) and get back exactly which check failed, why, and how
to fix it. Every check traces back to a real bug hit while shipping
[PlainText](https://smartcontractexplainer.onrender.com) and
[Ichimoku Signal](https://ichimoku-signal.onrender.com).

[![x402 Doctor in 70 seconds](https://raw.githubusercontent.com/Fizzl13/x402-doctor/explainer-video/poster.jpg)](https://x402-doctor.onrender.com/media/explainer.mp4)

▶ **[Watch the 70-second explainer](https://x402-doctor.onrender.com/media/explainer.mp4)** (with voice and captions):
diagnosing a broken endpoint, the pre-payment check for agents, and the daily Trust Index.

[![x402 Doctor: the paid fix](https://raw.githubusercontent.com/Fizzl13/x402-doctor/fix-video/poster.jpg)](https://x402-doctor.onrender.com/media/fix.mp4)

▶ **New: [the paid fix in 70 seconds](https://x402-doctor.onrender.com/media/fix.mp4)**: for $0.05 the Doctor hands you
the medicine, the exact code that fixes each problem for your stack, in the browser or as JSON for agents.

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
| Who can pay | `wallets` | Per wallet (MetaMask, Coinbase Wallet, Rabby, Phantom, Solflare, Backpack, x402 agents): the networks where payment works and where it fails, and why. Also in the JSON report as `wallets` |
| | `evm-payto-eoa` | EVM payout wallet is a regular wallet (EOA): MetaMask's Blockaid check may flag the payment signature as "a deceptive request". Info, with how to get it cleared |
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
- Browsers opening the route get a wallet paywall (Base first: MetaMask, Coinbase Wallet) instead of the bare 402.
- Bazaar: a facilitator lists a route after the first payment it settles for it. With the CDP keys set, one paid
  call (e.g. from the browser paywall) puts the route in the CDP Bazaar that agents search.

```bash
# pay-per-call from Node with @x402/fetch
const paidFetch = wrapFetchWithPayment(fetch, client);   // client with an EVM or SVM signer
const report = await (await paidFetch("https://<host>/api/v1/diagnose?url=https://api.example.com/paid")).json();
```

### Pre-payment check for buyers: `GET /api/v1/preflight`

`GET /api/v1/preflight?url=<endpoint>&max_usd=0.05&network=<caip2>&method=GET|POST`, **$0.001 USDC per call**:
call it before your agent pays an x402 endpoint it has not used before. It never pays the endpoint.

```json
{
  "verdict": "go",                     // go | caution | no_go
  "safe_to_pay": true,
  "summary": "OK to pay: $0.02 on Solana.",
  "recommended_option": 1,             // index into the endpoint's accepts[]
  "options": [{ "network": "eip155:8453", "asset_symbol": "USDC", "usd": 0.02, "payable": true, "problems": [] }, …],
  "signals": { "https": true, "advertised_price_usd": 0.02, "listed_in_cdp_bazaar": true },
  "reasons": [],                       // [{ level: no_go | caution | info, code, message }]
  "cached": false
}
```

| Verdict | When |
|---|---|
| `no_go` | No 402 or no valid challenge; every option would fail to settle (bad payTo/amount, missing fee payer or EIP-712 domain, Solana payout wallet without a token account); cheapest option above `max_usd`; no payable option on the requested `network` |
| `caution` | Charges more than its OpenAPI advertises; not HTTPS; not a known USDC contract; decimal amount; resource URL differs from the requested URL; testnet only |
| `go` | None of the above. `recommended_option` is the cheapest payable USDC option (on `network` if given) |

Not being listed in the CDP Bazaar is reported as `info` only. Results are cached for 10 minutes per URL, budget
and network (`cached: true`), so checking before every payment stays fast.

### The fix, as code: `GET /api/v1/fix`

`GET /api/v1/fix?url=<endpoint>&method=GET|POST&stack=<optional>`, **$0.05 USDC per call**: diagnoses the endpoint,
then returns, per failed or warning check, the concrete change that fixes it, as code for your stack and filled in
with your own values (payTo, amount, network, route).

```json
{
  "stack": { "id": "express", "name": "Express (@x402/express)", "detected_from": "x-powered-by: Express" },
  "summary": "3 fixes (1 blocking), for Express (@x402/express).",
  "fixes": [
    {
      "recipe": "amount",
      "severity": "warn",
      "checks": ["accepts[0]-amount"],
      "title": "Amount \"0.01\" → \"10000\" ($0.01)",
      "why": "x402 amounts are integer strings in the token's smallest unit; USDC has 6 decimals.",
      "steps": ["Easiest: let the SDK convert it by using price: \"$0.01\" instead of an amount."],
      "code": [{ "language": "javascript", "stack": "node", "label": "Route config", "snippet": "accepts: [{ scheme: \"exact\", price: \"$0.01\", ... }]" }],
      "verify": "Run x402 Doctor again on https://…; accepts[0]-amount should pass."
    }
  ],
  "unfixed": []
}
```

The stack is read from the response headers (`x-powered-by`, `server`, Vercel/Render/Cloudflare headers) and the
challenge: `express`, `next`, `hono`, `node` (an @x402 SDK behind another framework), `python` or `generic` (raw
HTTP, for any language). Pass `stack=` when the guess is wrong. Node snippets use the @x402 v2 route config, which is
the same for @x402/express, /next and /hono; lines that only apply to Express say so.

Recipes (`lib/recipes.js`, one test each in `test/recipes.test.js`): no 402 at all (200 before the paywall, auth or
validation first, 404/405, unreachable), v1 or invalid challenge, wrong header name, no body mirror, no accepts,
scheme, legacy network names, invalid payTo (spots quotes, spaces, the wrong chain), USDC asset, decimal amounts,
Solana fee payer, EIP-712 domain, http resource URL behind a proxy, resource URL and metadata, Bazaar declaration and
example, Solana payout token account, Phantom on PayAI, testnet paywall on mainnet, and openapi.json. Anything
without a recipe is returned under `unfixed` with the diagnosis hint.

### x402 Trust Index

Once a day, [`trust-scan.yml`](.github/workflows/trust-scan.yml) runs the pre-payment check against every resource in
the CDP Bazaar (read-only: it stops at the 402 challenge, at most two requests per host at a time, one
`/openapi.json` per origin, a User-Agent that links to `/trust`). The results roll into a 30-day history per resource,
one letter per day (`g` go, `c` caution, `n` no-go, `x` unreachable, `-` not scanned), published as
`index.json` + `summary.json` on the `trust-data` branch.

- The pre-payment check adds `signals.track_record` and a `caution` (`unreliable_history`) when a seller was
  payable on fewer than half of at least 3 scanned days.
- `GET /api/trust?url=<resource>` (free, 30/min per IP): the track record of one resource.
  `GET /api/trust/summary`: totals of the latest scan. `/trust`: the public page, with lookup and the scan's rules.
- Run it yourself: `node scripts/trust-scan.js --out trust-data --limit 200`.

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
| `DOCTOR_PREFLIGHT_PRICE` | Price per pre-payment check (default `$0.001`) |
| `DOCTOR_FIX_PRICE` | Price per fix (default `$0.05`) |
| `FACILITATOR_URL` | x402 facilitator (default PayAI, `https://facilitator.payai.network`) |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Use Coinbase's CDP facilitator first (PayAI stays the fallback). Payments settled through CDP get the route listed in the CDP Bazaar |

| `USAGE_LOG_TOKEN` | Fine-grained GitHub token with Contents read/write on the usage-log repo only. Every call is logged there (see below) |
| `USAGE_LOG_REPO` | The private usage-log repo (default `Fizzl13/usage-log`) |
| `ADMIN_PASSWORD` | Password for `/admin/usage` (any user name). Without it the admin pages do not exist |

Without either payout wallet the paid route answers 503 and the rest of the app works as before.

### Usage dashboard

`/admin/usage` shows every call to the Fizzl services (x402 Doctor, PlainText, Ichimoku Signal, presign-guard):
totals, revenue, paying wallets, calls per day per service, the most asked inputs and the latest calls with what
was filled in, the result and the payment (with a Basescan/Solscan link). Each service appends one JSON line per
call to `events/<service>/<YYYY-MM-DD>.jsonl` in the private usage-log repo (`lib/usage-log.js`, copied into
each service); the dashboard reads it back (`lib/usage-reader.js`). 402 challenges, health checks and static
files are not counted, and inputs are cut to 300 characters. Logging never delays or fails a request.

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
lib/paid-api.js        GET /api/v1/diagnose, /preflight and /fix behind x402 (Base + Solana USDC)
lib/recipes.js         The fix per failed check, as code for the detected stack
lib/stack.js           Which stack runs an endpoint, from its response headers
lib/preflight.js       Pre-payment check: verdict, recommended option, reasons (cached)
lib/bazaar-index.js    Cached CDP Bazaar index (listing signal for preflight)
lib/trust-scan.js      Trust Index scan: catalog, polite fetch, 30-day history
lib/trust-index.js     Reads the published index for preflight and /api/trust
scripts/trust-scan.js  Daily scan entry point (trust-scan.yml)
public/trust.html      /trust page
lib/media.js           Serves the explainer and paid-fix videos from their branches (/media/explainer.mp4, /media/fix.mp4)
media/explainer/       Explainer video pipeline (script, voice, recording, encoding)
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
