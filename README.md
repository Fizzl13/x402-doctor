# x402 Doctor

[![x402 payable](https://x402-doctor.fizzl.eu/badge.svg?url=https%3A%2F%2Fx402-doctor.fizzl.eu%2Fapi%2Fv1%2Fdiagnose)](https://x402-doctor.fizzl.eu/trust?url=https%3A%2F%2Fx402-doctor.fizzl.eu%2Fapi%2Fv1%2Fdiagnose) · [Live status](https://x402-doctor.fizzl.eu/status)

Diagnoses why an x402-payable endpoint's payment flow is broken, without needing a funded wallet.

Paste a URL (web app) or run `x402-doctor <url>` (CLI, CI) and get back exactly which check failed, why, and how
to fix it. Every check traces back to a real bug hit while shipping
[PlainText](https://plaintext.fizzl.eu) and
[Ichimoku Signal](https://ichimoku-signal.fizzl.eu).

[![x402 Doctor in 70 seconds](https://raw.githubusercontent.com/Fizzl13/x402-doctor/explainer-video/poster.jpg)](https://x402-doctor.fizzl.eu/media/explainer.mp4)

▶ **[Watch the 70-second explainer](https://x402-doctor.fizzl.eu/media/explainer.mp4)** (with voice and captions):
diagnosing a broken endpoint, the pre-payment check for agents, and the daily Trust Index.

[![x402 Doctor: the paid fix](https://raw.githubusercontent.com/Fizzl13/x402-doctor/fix-video/poster.jpg)](https://x402-doctor.fizzl.eu/media/fix.mp4)

▶ **New: [the paid fix in 70 seconds](https://x402-doctor.fizzl.eu/media/fix.mp4)**: for $0.05 the Doctor hands you
the medicine, the exact code that fixes each problem for your stack, in the browser or as JSON for agents.

## What it checks

| Group | Check | Catches |
|-------|-------|---------|
| 402 challenge | `returns-402` | No 402 for GET or POST (tries both, or `--method`) |
| | `protocol-version`, `challenge-header` | v1 vs v2, missing `x402Version`, challenge in the wrong header, undecodable header |
| | `envelope-body-mirror` | Header-only challenge (`@x402/express` sends `{}`), header and body disagreeing |
| MCP (payment per tool call) | `mcp-server` | When the URL answers no 402 but speaks MCP (Streamable HTTP, JSON or SSE, with or without a session): initialize and `tools/list` without payment |
| | `mcp-paid-tools` | No tool description says it is paid (x402, USDC, a price), so agents can't tell |
| | `mcp-payment-required` | One unpaid `tools/call` per paid-looking tool (at most 2; explicitly paid tools first — "Paid …" or a price / "via x402" in the title; never tools that call themselves free, destructive tools, or write tools unless explicitly paid). A free answer warns only for an explicitly paid tool, otherwise it is info: the x402 payment requirement in the tool result with `isError: true` (as `@x402/mcp`), or an HTTP 402 with `PAYMENT-REQUIRED` instead (payable over HTTP, not by `@x402/mcp` clients), a JSON-RPC error, a tool that answers for free, or example arguments refused before the payment step (publish one valid call as `_meta.examples` to avoid that). The requirement then gets the payment-option, settlement and wallet checks below |
| | `mcp-payment-text`, `mcp-payment-structured` | The requirement only in `structuredContent` (the x402 MCP transport requires JSON text in `content[0]`), or only as text (structuredContent preferred) |
| Payment options | `accepts[i]-scheme`, `-network` | Missing scheme; legacy names like `base` / `solana:mainnet` instead of CAIP-2 |
| | `accepts[i]-payto`, `-asset` | Invalid EVM/Solana addresses; asset that is not USDC, or USDC of another network (e.g. Base Sepolia USDC on Base) |
| | `accepts[i]-amount` | Decimal dollar amounts (`"0.02"`) instead of atomic units, zero or non-integer amounts |
| | `accepts[i]-extra` | Solana without `extra.feePayer` (clients throw "feePayer is required"), EVM without the EIP-712 `name`/`version` |
| Resource | `resource-url` | `http://` resource URL on an `https://` endpoint (Express behind a TLS proxy without `trust proxy`) |
| | `resource-metadata` | Missing description / mimeType |
| Settlement | `solana-payout-account` | Solana payout wallet without a token account for the asset: every settlement fails on-chain |
| | `solana-wallets` | Solana settled by PayAI, which rejects Phantom (Lighthouse instructions before the transfer) |
| Who can pay | `wallets` | Per wallet (MetaMask, Coinbase Wallet, Rabby, Phantom, Solflare, Backpack, x402 agents): the networks where payment works and where it fails, and why. Also in the JSON report as `wallets` |
| | `metamask-site-scan` | Only with `METAMASK_SCAN=on` (off by default: the endpoint has no published API or licence). MetaMask's site scanner (Blockaid) blocks the domain (e.g. "wallet drainer"): MetaMask users can't open the site or pay in the browser. With how to report a false positive. Agents are not affected |
| | `evm-payto-eoa` | EVM payout wallet is a regular wallet (EOA): MetaMask's Blockaid check may flag the payment signature as "a deceptive request". Info, with how to get it cleared |
| Discovery | `bazaar`, `bazaar-output` | Missing or invalid Bazaar declaration, output example not matching its schema |
| | `bazaar-replay` | The declared example request not answering 402, so the Bazaar cannot index it |
| | `openapi-present`, `openapi-title`, `openapi-guidance` | Missing `/openapi.json`, `info.title`, `info.x-guidance` |
| | `well-known` | `/.well-known/x402` missing (info), unreadable (resources as URLs or objects with a `url` are both read), or listing resources on another host than the one checked (built from the request `Host` header, it keeps pointing crawlers at an old domain). A platform address such as `*.onrender.com` pointing at its own domain is fine |
| | `bazaar-listing` | Where the CDP Bazaar lists this route (same path, same `payTo`): under this origin, not yet, or only under another host. The Bazaar keeps the URL the payer used, so after a domain move a route stays listed under the old host until someone pays through the new one. On the web check and the paid API (not the CLI) |
| Browser | `paywall` | Browser paywall in testnet mode on a mainnet endpoint (`@x402/paywall` defaults to testnet; the flag is read from JS or JSON config) |

Statuses: `pass`, `warn` (works, but something is off), `fail` (payments fail or it is not valid x402), `info`.

## Web app

```bash
npm install
npm start          # http://localhost:3001
```

Reports are shareable: `https://<host>/?url=<endpoint>&method=GET` runs the diagnosis on load.

API: `POST /api/diagnose` with `{ "url": "...", "method": "GET" | "POST" }` (method optional) returns
`{ url, method, overall, checks[], challenge, share_url }`: `share_url` is the page link above, to paste into an issue or a chat. Rate-limited to 10 diagnoses per minute per IP.

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

### Several endpoints at once: `GET /api/v1/preflight/batch`

`GET /api/v1/preflight/batch?url=<a>&url=<b>&max_usd=0.05`, **$0.005 USDC per call** for up to 10 endpoints (one
`url` parameter each; duplicates count once). For marketplaces, directories and agents that weigh several services.
Each endpoint gets the same verdict as a single preflight; one that errors or does not answer within 20 seconds is
`unknown` and does not hold up the rest.

```json
{
  "count": 2,
  "counts": { "go": 1, "caution": 0, "no_go": 1, "unknown": 0 },
  "results": [
    { "url": "https://a.example/paid", "verdict": "go", "safe_to_pay": true, "summary": "OK to pay: $0.02 on Base.", "recommended_option": 0, "options": […], "reasons": [] },
    { "url": "https://b.example/paid", "verdict": "no_go", "safe_to_pay": false, "summary": "Do not pay: …", … }
  ]
}
```

### Before an expensive call: `GET /api/v1/preflight/deep`

`GET /api/v1/preflight/deep?url=<endpoint>&max_usd=0.5`, **$0.01 USDC per call**: everything the preflight answers,
plus

- `diagnosis`: the full diagnosis (`overall`, every check, and the failing or warning ones as `problems`);
- `history`: the daily scans of the last 30 days, one `{ date, status }` per day;
- `seller`: the seller's other scanned endpoints on the same origin (how many, payable today, average payable ratio,
  how many were unreliable). A seller whose endpoints were payable on less than half of the scans turns `go` into
  `caution` (`unreliable_seller`);
- `domain`: the domain-move checks (`well-known`, `bazaar-listing`), e.g. a Bazaar listing only under an old domain.

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

### Learning from outcomes: `POST /api/v1/outcome`

After a paid preflight, a buyer can report (free) what happened when it then paid the endpoint: `paid_ok`, `paid_failed` (402 again) or `paid_error`. [x402-safe-fetch](https://www.npmjs.com/package/x402-safe-fetch) does it with `shareOutcomes: true`.

```json
{ "outcome": "paid_failed", "status": 402, "preflight": { …the signed preflight answer… }, "query": { "url": "…", "method": "GET", "max_usd": "0.05", "network": "eip155:8453" } }
```

- A report counts only with a real preflight that Doctor signed for exactly that query, once per preflight (`receipt.request_id`), so a false report costs a paid preflight.
- Doctor counts reports per endpoint over 30 days. When most reported payments failed, from at least three different paying wallets, later preflights add `payments_fail_after_preflight` (caution); `signals.agent_outcomes` shows the counts.
- Reports land in the usage log (endpoint, outcome, status, verdict, payer from the receipt); nothing else about the buyer.

### Signed verdicts

Every paid answer (diagnose, preflight, batch, deep and fix; HTTP and MCP) carries a `receipt` signed by Doctor, so an agent can later prove **which verdict it got for which endpoint**, for example why it did or didn't pay:

```json
"receipt": {
  "request_id": "…", "route": "GET /api/v1/preflight", "input_sha256": "…",
  "payment": { "network": "eip155:8453", "amount": "1000", "payer": "0x…", "nonce": "0x…", "proof": "eip3009" },
  "signed_at": "2026-09-27T08:00:00.000Z", "signer": "0x…",
  "algorithm": "eip191-canonical-json-v1", "signature": "0x…"
}
```

- **Signed:** the whole answer without `receipt.signature`, as canonical JSON (profile `js-json-stringify-sorted-utf16-ascii-v1`: keys sorted by UTF-16 code units, compact, every code unit from U+007F up as lowercase `\uXXXX`, numbers as JavaScript's `JSON.stringify` writes them — `1.0` → `1`, `0.000001` → `0.000001` — then UTF-8 bytes; Python's `json.dumps` matches only for ASCII keys and integers, so use [`examples/canonical.py`](examples/canonical.py), which also has `verify_receipt(answer)`), with EIP-191 `personal_sign`. Flipping the verdict or moving it to another request breaks it.
- **`payment`:** the payment that bought this answer, from your x402 payment payload. On Base the payer and the EIP-3009 nonce, so anyone can find the settlement on-chain as the USDC contract's `AuthorizationUsed(payer, nonce)` event; on Solana the payer and a SHA-256 of the signed transaction you sent.
- **`input_sha256`:** SHA-256 of the canonical JSON of `{"route", "input"}`, where `input` is your query parameters as strings (HTTP) or the tool arguments (MCP, route `mcp <tool>`).
- **Signer:** [`/.well-known/x402-doctor-signer.json`](https://x402-doctor.fizzl.eu/.well-known/x402-doctor-signer.json), with retired signers listed so old receipts keep verifying.
- **Free check:** `POST /api/v1/verify` with `{"response": …, "route": …, "input": …}` returns `valid`, `signer`, `known_signer` and `input_matches`.

**Key rotation without client updates:** the payout wallet (`0x6B0F4651eD42893ab58139938175E4a69f175F25`) authorises each signing key with a `personal_sign` over `fizzl receipt signer` / `service: x402-doctor` / `signer: <address>` / `valid_from: <YYYY-MM-DD>`. Set it as `RECEIPT_SIGNER_CERT` (`YYYY-MM-DD:0x<signature>`, produced by `/sign-receipt-key` in the wallet's browser). It is checked at startup and carried in every receipt as `receipt.cert`, so a client that pins only the payout wallet verifies a new key offline.

Same format as [presign-guard](https://github.com/Fizzl13/presign-guard#signed-verdicts), so one verifier works for both. The key comes from `RECEIPT_SIGNER_SECRET` (holds no funds); without it answers are unsigned.

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

### Weekly x402 health report

Every Monday, [`weekly-report.yml`](.github/workflows/weekly-report.yml) turns the last 7 days of the Trust Index into a
report: how many Bazaar resources are clean, payable with a caution or not payable, the most common reasons with the fix
for each, which networks payable resources accept, and what changed this week (broke, fixed, flaky, new). It names no
seller or host. The report, its numbers and drafts for X, Discord and Reddit (for a person to review and post) go to
`reports/<date>.md`, `.json` and `-posts.md` on the `weekly-reports` branch. Locally:
`node scripts/weekly-report.js --out reports [--index trust-data/index.json]`.

## MCP server

`https://x402-doctor.fizzl.eu/mcp` is an MCP server (Streamable HTTP, stateless) for Claude, Cursor and agent frameworks, listed in the official MCP registry as `io.github.Fizzl13/x402-doctor`.

| Tool | Price | Returns |
|---|---|---|
| `x402_quick_check` | free, 10 calls/hour | pass/warn/fail, the number of problems and the top three |
| `x402_diagnose` | $0.01 USDC via x402 | Every check with a fix hint, as `GET /api/v1/diagnose` |
| `x402_preflight` | $0.001 USDC via x402 | go/caution/no_go before paying an endpoint, as `GET /api/v1/preflight` |
| `x402_preflight_batch` | $0.005 USDC via x402 | The preflight for up to 10 endpoints (`urls`), as `GET /api/v1/preflight/batch` |
| `x402_preflight_deep` | $0.01 USDC via x402 | The preflight plus diagnosis, history, seller and domain checks, as `GET /api/v1/preflight/deep` |
| `x402_fix` | $0.05 USDC via x402 | The code changes for your stack, as `GET /api/v1/fix` |
| `feedback` | free | Report a bug or a missing feature, as `POST /feedback` (below) |

The paid tools are paid inside the MCP call with the x402 MCP transport (`_meta["x402/payment"]`), on Base or Solana, at the same prices and to the same payout wallets as the HTTP routes. Invalid input is refused before payment, and a failed call is not charged.

## Feedback

Found a bug, or missing something? Send it with `POST /feedback` (free, no payment) or the MCP tool `feedback`:

```bash
curl -X POST https://x402-doctor.fizzl.eu/feedback \
  -H 'content-type: application/json' \
  -d '{"type": "feature", "message": "Also check the facilitator /supported list", "endpoint": "/api/v1/diagnose"}'
```

`type` is `bug`, `feature` or `other`; `message` is required (up to 2000 characters); `endpoint` and `contact` are optional. The answer is `202` with an id. At most 10 reports per hour per caller. Reports go to the usage log (shown on `/admin/usage`), and a person reads every one; nothing in a report is run or changed automatically. `GET /feedback` shows the schema. A diagnosis never calls another server's `feedback` tool: tools that call themselves free are skipped.

## CLI

```bash
npx github:Fizzl13/x402-doctor https://api.example.com/paid
npx github:Fizzl13/x402-doctor https://api.example.com/paid --method POST --json
```

Exit code `0` on pass/warn, `1` when a check fails (or on warnings with `--strict`), `2` on usage errors.
The CLI can diagnose `localhost`, so you can run it against a dev server.

## GitHub Action

Check your x402 endpoints on every push. The step fails on a broken 402, each
problem shows up as an annotation on the run and the PR, and the job summary
lists what is wrong with the fix next to it.

```yaml
- uses: Fizzl13/x402-doctor@master
  with:
    urls: |
      https://your-api.example.com/paid
      https://your-api.example.com/other
```

| Input | Default | |
| --- | --- | --- |
| `urls` | (required) | One per line or comma separated. `localhost` works for a dev server started earlier in the job. |
| `method` | tries GET, then POST | `GET` or `POST` |
| `fail-on` | `fail` | `fail`: a failed check fails the step. `warn`: warnings too. `never`: report only. |

Outputs: `overall` (`pass`, `warn` or `fail`, the worst across the URLs) and
`report` (the full reports as JSON). The Action uses the runner's own Node
(20.18 or newer, as on GitHub-hosted runners) and does not change the job's
Node version. Read-only: no wallet, no payment.

Or the CLI in a plain `run:` step:

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
| `DOCTOR_BATCH_PRICE` | Price per batch pre-payment check, up to 10 endpoints (default `$0.005`) |
| `DOCTOR_DEEP_PRICE` | Price per deep pre-payment check (default `$0.01`) |
| `DOCTOR_FIX_PRICE` | Price per fix (default `$0.05`) |
| `FACILITATOR_URL` | x402 facilitator (default PayAI, `https://facilitator.payai.network`) |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Use Coinbase's CDP facilitator for Base (PayAI stays the fallback). Payments settled through CDP get the route listed in the CDP Bazaar |
| `DOCTOR_SOLANA_FACILITATOR` | With CDP keys set, Solana is settled by PayAI (CDP takes over if PayAI is down). Set to `cdp` to settle Solana through CDP too |
| `MPP_SECRET` | Turns on MPP payment (method `evm`, USDC on Base, via the same facilitator) next to x402 on the paid routes, for agents that speak MPP (mppx). Any long random string; it signs the challenge ids. Without it only x402 is offered |
| `OUTREACH_URL` / `OUTREACH_KEY` | Optional, both needed: when the free web check finds a broken endpoint (a fail) whose `/openapi.json` publishes `info.contact.email`, Doctor hands a draft e-mail to the Fizzl wallet server at `OUTREACH_URL` (`https://wallet.fizzl.eu`), authenticated with `OUTREACH_KEY` (the same long random string as there). The wallet server only makes a draft; the owner decides on Telegram or the dashboard whether it is sent. Fizzl's own hosts are skipped, and each host at most once a day |
| `TYPESAFE_API_KEY` | Optional: TypeSafe's Jev judges a broken endpoint before an outreach draft is made (lib/jev-triage.js): no draft for a test, preview or tunnel service, or for findings that would not hurt a paying agent. Off or failing: drafts as before. Plainly test addresses (staging., sandbox., testnet, tunnels, Vercel previews) and clear real problems (http resource.url on https, an internal or raw cloud-function resource.url, a price ≥ 1.5x the advertised one, no payable option) are decided by code without asking. With `ANTHROPIC_API_KEY` too, Claude decides the cases Jev is unsure about. The same keys as repository secrets let `.github/workflows/triage.yml` rank all Trust Index candidates by hand |
| `MPP_TEMPO_RECIPIENT` | With `MPP_SECRET`: also accepts MPP method `tempo` (push mode: the agent sends USDC.e on Tempo with the MPP memo and answers with the transaction hash, which the Doctor checks on a Tempo RPC). The address that receives it on Tempo; make sure you hold its key in a wallet that supports Tempo. Without it only `evm` is offered |
| `MPP_TEMPO_CHAIN` | `4217` (Tempo, default) or `42431` (Moderato testnet, pays in pathUSD) |
| `MPP_TEMPO_RPC` | Overrides the Tempo RPC (default `https://rpc.tempo.xyz`, or the Moderato one) |

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
lib/paid-api.js        GET /api/v1/diagnose, /preflight (+ /batch, /deep) and /fix behind x402 (Base + Solana USDC)
lib/recipes.js         The fix per failed check, as code for the detected stack
lib/stack.js           Which stack runs an endpoint, from its response headers
lib/preflight.js       Pre-payment check: verdict, recommended option, reasons (cached)
lib/preflight-plus.js  Batch (up to 10 endpoints) and deep pre-payment checks
lib/bazaar-index.js    Cached CDP Bazaar index (listing signal for preflight)
lib/trust-scan.js      Trust Index scan: catalog, polite fetch, 30-day history
lib/trust-index.js     Reads the published index for preflight and /api/trust
scripts/trust-scan.js  Daily scan entry point (trust-scan.yml)
public/trust.html      /trust page
lib/media.js           Serves the explainer and paid-fix videos from their branches (/media/explainer.mp4, /media/fix.mp4)
media/explainer/       Explainer video pipeline (script, voice, recording, encoding)
lib/diagnose.js        The checks
lib/site-scan.js       MetaMask's site scanner verdict for the domain
lib/mcp-check.js       x402 over MCP: tools/list, unpaid tools/call, the payment requirement in the tool result
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
