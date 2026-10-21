# x402 Doctor

[![x402 payable](https://x402-doctor.fizzl.eu/badge.svg?url=https%3A%2F%2Fx402-doctor.fizzl.eu%2Fapi%2Fv1%2Fdiagnose)](https://x402-doctor.fizzl.eu/trust?url=https%3A%2F%2Fx402-doctor.fizzl.eu%2Fapi%2Fv1%2Fdiagnose) [![Listed on x402-list](https://x402-list.com/badge/x402-doctor.svg)](https://x402-list.com/services/x402-doctor?utm_source=badge&utm_medium=referral&utm_campaign=embed) · [Live status](https://x402-doctor.fizzl.eu/status) · [![x402 Doctor MCP connector on Glama](https://glama.ai/mcp/connectors/io.github.Fizzl13/x402-doctor/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.Fizzl13/x402-doctor)

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
| 402 challenge | `returns-402` | No 402 for GET or POST (tries both, or `--method`). Behind Cloudflare or Amazon CloudFront the hint names the usual Monetization Gateway or AWS WAF Monetize rule misses. An endpoint that asks for x401 proof first is info, not a failure. A POST that answers 400 or 422 to an empty body checks its input before payment: Doctor sends the `requestBody` example from the seller's `/openapi.json` (or one built from its schema), or your own example body, and without one the check is a warning (needs input), not a failure |
| | `x401` | An x401 proof request (`PROOF-REQUEST`, [x401.id](https://x401.id)) instead of a 402: the endpoint asks who is behind the agent before it asks for payment. Pass when the base64url payload names scheme `x401`, a version and credential requests (with their protocols, the token endpoint and the payment hint); a warning when agents can't read it; info for the older header name `PROOF-REQUIRED` |
| | `protocol-version`, `challenge-header` | v1 vs v2, missing `x402Version`, challenge in the wrong header, undecodable header |
| | `envelope-body-mirror` | Header-only challenge (`@x402/express` sends `{}`), header and body disagreeing |
| MCP (payment per tool call) | `mcp-server` | When the URL answers no 402 but speaks MCP (Streamable HTTP, JSON or SSE, with or without a session): initialize and `tools/list` without payment |
| | `mcp-paid-tools` | No tool description says it is paid (x402, USDC, a price), so agents can't tell |
| | `mcp-payment-required` | One unpaid `tools/call` per paid-looking tool (at most 2; explicitly paid tools first — "Paid …" or a price / "via x402" in the title; never tools that call themselves free, destructive tools, or write tools unless explicitly paid). A free answer warns only for an explicitly paid tool, otherwise it is info: the x402 payment requirement in the tool result with `isError: true` (as `@x402/mcp`), or an HTTP 402 with `PAYMENT-REQUIRED` instead (payable over HTTP, not by `@x402/mcp` clients), a JSON-RPC error, a tool that answers for free, or example arguments refused before the payment step (publish one valid call as `_meta.examples` to avoid that). The requirement then gets the payment-option, settlement and wallet checks below |
| | `mcp-tool-poisoning` | Hidden orders for the agent in tool descriptions (tool poisoning): hidden Unicode characters, `<IMPORTANT>` blocks, reading `~/.ssh` or `.env`, "do not tell the user", sending the maximum USDC (code rules), then TypeSafe Jev per tool (with `TYPESAFE_API_KEY`). A sure finding is `warn`, an unsure one `info`. Calibrated on 755 tools of 96 servers from the official MCP registry: no false alarm, and five made-up poisoned tools all caught |
| | `mcp-payment-text`, `mcp-payment-structured` | The requirement only in `structuredContent` (the x402 MCP transport requires JSON text in `content[0]`), or only as text (structuredContent preferred) |
| Payment options | `accepts[i]-scheme`, `-network` | Missing scheme; legacy names like `base` / `solana:mainnet` instead of CAIP-2 |
| | `accepts[i]-payto`, `-asset` | Invalid EVM, Solana, XRPL or Algorand addresses (XRPL and Algorand with their checksums); a payTo that is a placeholder nobody holds a key for (the zero address, which USDC refuses, `0x…dEaD`, or Solana's System Program or incinerator), also as an MPP `recipient`; asset that is not USDC, or USDC of another network (e.g. Base Sepolia USDC on Base); on Algorand an asset that is not an ASA id (USDC is ASA 31566704); on XRPL an XRP amount that isn't in drops, or "RLUSD" from another issuer than Ripple's |
| | `accepts[i]-amount` | Decimal dollar amounts (`"0.02"`) instead of atomic units, zero or non-integer amounts |
| | Stellar options | x402 `exact` on Stellar (`stellar:pubnet`, `@x402/stellar`): payTo a G…, C… or M… address with a valid StrKey checksum, asset a Soroban token contract (USDC is `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`; `"USDC"` or a testnet contract fails), a positive integer amount (USDC has 7 decimals: `100000` is $0.01) and `extra.areFeesSponsored: true`, without which the client refuses |
| | `aws-test-mode` | A 402 served through Amazon CloudFront that offers only testnets (info): AWS WAF Monetize left in Test currency mode |
| | `accepts[i]-extra` | Solana without `extra.feePayer` (clients throw "feePayer is required"), EVM without the EIP-712 `name`/`version` |
| | `accepts[i]-batch`, `-batch-delay`, `-batch-deposit`, `batch-escrow` | The `batch-settlement` scheme (one deposit into the x402 escrow, then a signed voucher per call, claimed in batches): `extra.receiverAuthorizer` missing (clients refuse), `withdrawDelay` missing or outside 900 s to 30 days, no EIP-712 domain for the EIP-3009 deposit, `minDeposit` not in atomic units, the escrow not deployed on the network; the deposit and withdraw delay buyers commit to |
| | `accepts[i]-auth-capture`, `-auth-escrow`, `-auth-deadlines`, `-auth-fees`, `-auth-domain`, `-auth-flow`, `auth-capture-escrow` | The `auth-capture` scheme on EVM (the buyer signs once; the amount is held in the commerce-payments escrow until the seller captures it, with refunds until a deadline): no operator (`extra.captureAuthorizer`), an escrow that is neither commerce-payments v1.1 nor v1.0, a capture deadline that has passed or a refund deadline before it, fee bounds outside 0 <= min <= max <= 10000 bps or no fee recipient, no EIP-712 domain for the EIP-3009 authorization, a `charge` (`paymentFlow` `authorization`) without `receiverAuthorizer`, the escrow not deployed on the network; when the money is captured and until when it can be refunded |
| | `accepts[i]-cloudflare`, `-payto`, `-amount`, `cloudflare-registration` | Cloudflare pay per crawl (`batch-settlement` on network `cloudflare:402`): `payTo` must be `merchant` (Cloudflare settles, as merchant of record), the price is a currency code (`USD`) and an amount in cents, and the 402 carries the `http-message-signatures` extension with the URL where agents register their signing key. Paid by crawlers and agents registered with Cloudflare (Web Bot Auth), not by wallets: the preflight says caution (`cloudflare_crawler_only`), not no-go |
| | `accepts[i]-extra`, `circle-gateway`, `accepts-order` | Circle Gateway options ("exact" signed for the Gateway Wallet, domain `GatewayWalletBatched`): `extra.version` other than "1" or no `verifyingContract` (Circle's client skips or can't sign it), a contract that isn't Circle's Gateway Wallet; who can pay them (a Gateway balance and Circle's client, not standard x402 clients or browser wallets; their 7-day timeout is right); a Gateway option listed before the standard one on the same network, which x402 clients would pick and fail |
| | `accepts[i]-scheme` | A scheme standard x402 clients don't pay (anything but `exact`, `upto`, `batch-settlement` and `auth-capture`; `eip3009` gets the hint to use `exact`): what it requires is unknown, so a missing or unusual payTo, asset or amount is a warning, not a fail (a burn address stays a fail). The preflight never recommends such an option over a standard one; with only such options it says caution (`custom_scheme_only`) |
| | `accepts[i]-scheme`, `-network`, `-plan` | Nevermined plans (`nvm:erc4337` on `eip155:<id>`, `nvm:card-delegation` on `stripe`, `braintree` or `visa`): no payTo or amount is asked, since the price is in the plan; the network must be the settlement rail (not `sandbox` or `live`), `planId` a plan id and `extra.agentId` set. The preflight says caution (`nevermined_plan`): payable only with a Nevermined account and its SDK, not by standard x402 clients |
| Resource | `resource-url` | `http://` resource URL on an `https://` endpoint (Express behind a TLS proxy without `trust proxy`); a path instead of a full URL (judged against the endpoint, a warning) |
| | `resource-metadata` | Missing description / mimeType |
| Settlement | `solana-payout-account` | Solana payout wallet without a token account for the asset: every settlement fails on-chain |
| | `xrpl-payout-account`, `xrpl-payout-trustline` | XRPL payout account that was never activated, has Deposit Authorization on, or requires a destination tag the option doesn't give; for a token like RLUSD, no (or a frozen) trust line to its issuer: every payment fails |
| | `accepts[i]-lightning`, `lightning-invoice`, `lightning-request-hash` | Bitcoin Lightning (x402 `exact` on `lnbtc`, Sept 2026): payTo must be the node key, amount in millisatoshis, `paymentFlow: "upfront"` and a request binding (`http:1`/`mcp:1`); the BOLT11 invoice in `extra.invoice` is decoded and must match the option exactly (amount, `bc`/`tb`, expiry = `maxTimeoutSeconds`, signed by payTo, not expired) and commit to `extra.requestHash`, which for `http:1` is recomputed for the doctor's own request |
| | `algorand-payout-optin` | Algorand payout address that has not opted in to the asset (an account can only receive an ASA after opting in): every payment fails |
| | `stellar-payout-trustline` | Stellar payout account (G…) that was never funded, or has no (or an unauthorised) trustline to Circle's USDC: every payment fails. Read from Horizon; a contract (C…) needs none |
| | `solana-wallets` | Solana settled by PayAI, which rejects Phantom (Lighthouse instructions before the transfer) |
| Who can pay | `wallets` | Per wallet (MetaMask, Coinbase Wallet, Rabby, Phantom, Solflare, Backpack, Pera, Defly, Xaman, Crossmark, GemWallet, x402 agents, which also pay Stellar): the networks where payment works and where it fails, and why. Also in the JSON report as `wallets` |
| | `metamask-site-scan` | Only with `METAMASK_SCAN=on` (off by default: the endpoint has no published API or licence). MetaMask's site scanner (Blockaid) blocks the domain (e.g. "wallet drainer"): MetaMask users can't open the site or pay in the browser. With how to report a false positive. Agents are not affected |
| | `evm-payto-eoa` | EVM payout wallet is a regular wallet (EOA): MetaMask's Blockaid check may flag the payment signature as "a deceptive request". Info, with how to get it cleared |
| | `coinbase-agents` | Whether Coinbase's agent wallets can pay: Wallet MCP pays x402 in USDC on Base with `exact`, `upto` or `auth-capture` and finds services through the CDP Bazaar (the line says whether this route is listed there, from `bazaar-listing`); the Coinbase MCP also needs x402 v2 and at most $5 a call, and fetches only its own curated catalog. Info when there is no USDC on Base or only another scheme |
| Discovery | `bazaar`, `bazaar-output` | Missing or invalid Bazaar declaration, output example not matching its schema |
| | `market-price` | Where your price sits among comparable paid APIs of other sellers in the x402 Trust Index (median and range; comparable as judged by TypeSafe Jev, with `TYPESAFE_API_KEY`). Always `info`; the hint speaks up when agents' preflights would point at cheaper services, or when you charge far less than the rest |
| | `bazaar-replay` | The declared example request not answering 402, so the Bazaar cannot index it |
| | `bazaar-route` | A Bazaar `routeTemplate` that is not a path (e.g. `:var1`) or has a `:param` without a `pathParams` value, so the request built from it is an invalid URL |
| | `openapi-present`, `openapi-title`, `openapi-guidance` | Missing `/openapi.json`, `info.title`, `info.x-guidance` |
| | `openapi-contact`, `openapi-ownership`, `openapi-input-schema`, `openapi-free-routes` | What x402scan and AgentCash read beyond that: `info.contact.email` (info), an ownership proof under `x-agentcash-provenance.ownershipProofs`, checked by recovering the signer of the bare origin against the EVM `payTo` (pass, or a warning for a trailing slash, another signer, a broken signature or a top-level `ownershipProofs` that x402scan ignores), paid operations without `parameters` or `requestBody` (x402scan does not register them) and operations with neither `x-payment-info` nor `"security": []` (free ones are reported as unprotected). Info lines unless a proof is present but wrong |
| | `well-known` | `/.well-known/x402` missing (info), unreadable (resources as URLs or objects with a `url` are both read), or listing resources on another host than the one checked (built from the request `Host` header, it keeps pointing crawlers at an old domain). A platform address such as `*.onrender.com` pointing at its own domain is fine |
| | `well-known-names` | Resources in `/.well-known/x402` without a `name` and `description` (info): directories such as the XRPL AI Hub list each resource by them. |
| | `agent-instructions` | `/skill.md` on the origin, so a user can tell an agent `connect to <host>/skill.md` (Coinbase's pattern); `/llms.txt` counts as the older form, and an HTML page served on every path does not count. Info when there is none |
| | `bazaar-listing` | Where the CDP Bazaar lists this route (same path, same `payTo`): under this origin, not yet, or only under another host. The Bazaar keeps the URL the payer used, so after a domain move a route stays listed under the old host until someone pays through the new one. On the web check and the paid API (not the CLI) |
| | `bazaar-last-payment` | When the CDP Bazaar lists the route here: how long ago it counted the last settled payment. From 21 days a warning, since the Bazaar drops a route after 30 days without one (one paid call keeps it listed). |
| | `cdp-validate` | Coinbase's own verdict: Doctor asks CDP's free validate API whether the CDP facilitator would index the route in the Bazaar (the index Coinbase's agents search), and shows the failures it names, without the ones it skips after the first. A warning when the endpoint offers Base or Solana, info otherwise; a pass may carry CDP's advice. HTTPS only; nothing when CDP doesn't answer. Answers cached 10 minutes. On the web check, the paid diagnose and fix, and MCP (not the CLI); the daily health check also runs it on every Fizzl paid route. `CDP_VALIDATE=off` turns it off |
| | `merchant` | The `x402-merchant` extension (name, website, logo, categories) that GoPlausible's catalog shows on the seller: a warning when malformed, an info line when it is missing on an endpoint that offers Algorand |
| | `builder-code` | The Base Builder Code (ERC-8021, the x402 `builder-code` extension): the buyer's client echoes the app code and the facilitator writes it into the settlement, so Base attributes the payment. A warning when the facilitator would drop it (code not under `info`, an invalid or missing `info.a`, invalid or too many service codes, an x402 v1 challenge); an info line when a route that settles on Base has none, or when no option settles on an EVM chain |
| Browser | `paywall` | Browser paywall in testnet mode on a mainnet endpoint (`@x402/paywall` defaults to testnet; the flag is read from JS or JSON config) |

Statuses: `pass`, `warn` (works, but something is off), `fail` (payments fail or it is not valid x402), `info`.

## Web app

```bash
npm install
npm start          # http://localhost:3001
```

Reports are shareable: `https://<host>/?url=<endpoint>&method=GET` runs the diagnosis on load (`&method=POST&body=<json>` for a POST with an example body).

API: `POST /api/diagnose` with `{ "url": "...", "method": "GET" | "POST", "body": { ... } }` (method and body optional)
returns `{ url, method, overall, checks[], challenge, share_url }`. `body` is an example request body (JSON, up to
16 KB) for a POST that checks its input before the 402; it implies POST, and the report says which body reached the 402
(`body`, and `body_source` when it came from the seller's `/openapi.json`). `share_url` is the page link above, to paste into an issue or a chat. Rate-limited to 10 diagnoses per minute per IP.

## Paid API for agents (x402)

`GET /api/v1/diagnose?url=<endpoint>&method=GET|POST` returns the same report, **$0.01 USDC per call** on Base or
Solana via x402, with no rate limit. It is meant for agents and CI pipelines; the web page stays free.

- Unpaid requests get the x402 challenge (`PAYMENT-REQUIRED` header, mirrored in the body) with a Bazaar input and
  output schema.
- `body=<URL-encoded JSON>` (optional, also on preflight, deep and fix, and as `body` in the MCP tools): an example
  request body for a POST route that checks its input before the 402. It implies POST; with `method=GET`, or when it
  is not JSON, the answer is a 400 before payment. The batch takes no body.
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
call it before your agent pays an x402 endpoint it has not used before. It never pays the endpoint. Add
`client=gateway` when your agent pays with Circle's Gateway client from a Gateway balance: Circle Gateway-only
endpoints (`gateway_only`, otherwise a caution) are then a go, and a Gateway option is recommended first.

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
| `no_go` | No 402 or no valid challenge; every option would fail to settle (bad payTo/amount, a payTo that is the zero or another burn address (`payto_burn`, caution when another option is payable), missing fee payer or EIP-712 domain, Solana payout wallet without a token account); cheapest option above `max_usd`; no payable option on the requested `network` |
| `caution` | Charges more than its OpenAPI advertises; not HTTPS; not a known USDC (or BNB Chain dollar token) contract; decimal amount, or a 6-decimal amount on an 18-decimal token; resource URL differs from the requested URL; testnet only; bait (below); 20x or more above comparable services (below) |
| `go` | None of the above. `recommended_option` is the cheapest payable USDC option (on `network` if given); at the same price, one every x402 client can pay (EIP-3009, not Permit2) and USDC before other dollar tokens |

**BNB Chain** (`eip155:56`) has no Circle USDC. Sellers price in 18-decimal dollar tokens: Binance-Peg USDC, USDT,
USD1 and United Stables (U), so $0.01 is `"10000000000000000"`. Doctor prices those options like USDC. USDC and USDT
there have no EIP-3009, so an option without `assetTransferMethod: "permit2"` fails; a value standard x402 clients
don't know is a warning, because `@x402/evm` then signs EIP-3009 instead. `"permit2-exact"` and `"permit2-upto"` are the
methods of Binance's B402 facilitator, so only its own clients pay those options.

**Bait check** (TypeSafe's Jev, when `TYPESAFE_API_KEY` is set): for an endpoint that could be paid, Jev judges
what the protocol checks can't. Does it claim to be, or to be official from or endorsed by, a brand that doesn't own
its domain (`brand_impersonation`; reselling or proxying a brand's product under the seller's own name, such as an
LLM gateway naming the models it serves, is not), lure with free tokens, airdrops or guaranteed returns (`lure_description`), or
promise something its declared output doesn't deliver (`output_mismatch`)? A clear yes is a `caution`, an
in-between answer `info`; it never makes a verdict `no_go` and never turns one into `go`. The probabilities are
in `signals.jev_lure`. On 300 real CDP Bazaar listings it raised no caution for brand or lure wording. When a bait
question changes (`BAIT_VERSION` in `lib/jev-lure.js`), the Trust Index's next run asks again, first, every service
the old wording flagged or was unsure about; clear answers carry over.

**Price check** (same key): is the price far above what comparable services ask? Doctor takes up to 24 paid APIs
of other sellers from the x402 Trust Index whose descriptions share rare words with this one (at most two per
seller), and Jev judges per candidate whether a buyer would be served just as well by it. With at least 5 such
services, their median price is the comparison: 5x or more (and at least $0.05 more) is `info`, 20x or more (and
at least $0.25 more) a `caution`, both `price_high` and naming up to three cheaper alternatives. The comparison is
in `signals.price_check` (`comparable_median_usd`, `comparables`, `ratio`, `cheaper[]`). It never makes a verdict
`no_go`: the price is the seller's choice, the agent decides whether it is worth it.

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

### Paid and delivered? `GET /api/v1/delivery-check`

`GET /api/v1/delivery-check?url=<endpoint>&method=GET|POST`, **$0.25 USDC per check**: x402 Doctor buys the endpoint
once, with the example input its own listing declares, and publishes what came back. For sellers who want proof that
their endpoint delivers, and for buyers before a large order.

- **Checked before you pay**: the endpoint must be https, not a fizzl.eu route, get a `go` from the pre-payment check,
  be payable in USDC on Base and cost at most $0.10. Anything else answers 400 (or 503 when the day's 20 checks are
  taken), and nothing is charged. A request with a payment always waits for the whole check before anything
  settles. A probe without a payment wants the 402: it gets one unless the request itself is malformed (not one
  https URL, a fizzl.eu route, a bad method), also for an endpoint that can't be bought now, since uptime monitors
  fill `url` with a placeholder such as `https://example.com`, and within 5 seconds (the CDP Bazaar's validator and
  health probe give up after 10). To get the answer before paying, send `X-Delivery-Precheck: 1`; the homepage does.
- **The answer comes at once, the purchase shortly after**: the paid call answers with a job `id` and a `status_url`.
  [`delivery-check.yml`](.github/workflows/delivery-check.yml) takes the queue (`GET /api/v1/delivery-check/queue`,
  free) and buys with the dedicated spot-buy wallet (`SPOT_BUY_KEY`; no wallet key on the server). Only a job whose
  payment settled is released to the queue. The server starts the workflow as soon as a payment settles
  (`DELIVERY_DISPATCH_TOKEN`: a fine-grained GitHub token for this repository with only Actions read and write;
  `lib/delivery-dispatch.js`); its schedule, every 10 minutes, is the fallback, since GitHub runs scheduled
  workflows late or not at all.
- **The same steps as the spot-buy** (`lib/spot-buy.js`): a fresh preflight with the OFAC payout screen right before
  paying, the seller's declared example input, the answer checked against the declared output schema, and the charge
  measured on chain.
- **Public result**: `GET /api/v1/delivery-check/<id>` (free) shows `queued`, then `done` with the result
  (`delivered`, `off_schema`, `empty`, `charged_not_delivered`, `payment_rejected`, `error_not_charged`, or the step
  that stopped it before paying) and the transaction. Every result is on the `delivery-data` branch.
- **Caching**: for a delivered GET answer, `cache` says whether a shared cache (a CDN) may store the paid answer
  and serve it to callers who did not pay (`shared_cache`: `yes`, `no` or `unspecified`, with the `Cache-Control`
  it sent). The x402 payment travels in its own header, not in `Authorization`, so only `Cache-Control: private` or
  `no-store` keeps it out ([Five Attacks on x402](https://arxiv.org/abs/2605.11781), attack III).

Jobs are kept in the credits Redis (`CREDITS_REDIS_URL`); without it the route answers 503 before payment.

### Prepaid credits: `GET /api/v1/credits/1000`

Agents that check often can prepay: one x402 payment of **$0.80 for 1000 credits** or **$7.00 for 10,000** (20% and 30% off), valid for a year. A credit is $0.001: a preflight costs 1, a batch 5, a deep preflight or a diagnosis 10, the fix 50. The pack answers with a `credit_key`; send it as the `x-credit-key` header with any paid call instead of paying. `GET /api/v1/credits` (free) shows the prices and, with the header, your balance. A call that fails gives its credits back; with no key or too few credits the normal 402 applies. Needs `CREDITS_REDIS_URL` (a persistent Redis such as Upstash; the presign-guard instance is fine, the keys are apart); without it, no packs are sold.

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
- **Free check:** `POST /api/v1/verify` with `{"response": …, "route": …, "input": …}` returns `valid`, `signer`, `known_signer` and `input_matches`. Over MCP: the free tool `verify_receipt` with the same arguments (`route` like `mcp x402_preflight`, `input` the tool arguments).

**Key rotation without client updates:** the payout wallet (`0x6B0F4651eD42893ab58139938175E4a69f175F25`) authorises each signing key with a `personal_sign` over `fizzl receipt signer` / `service: x402-doctor` / `signer: <address>` / `valid_from: <YYYY-MM-DD>`. Set it as `RECEIPT_SIGNER_CERT` (`YYYY-MM-DD:0x<signature>`, produced by `/sign-receipt-key` in the wallet's browser). It is checked at startup and carried in every receipt as `receipt.cert`, so a client that pins only the payout wallet verifies a new key offline.

Same format as [presign-guard](https://github.com/Fizzl13/presign-guard#signed-verdicts), so one verifier works for both. The key comes from `RECEIPT_SIGNER_SECRET` (holds no funds); without it answers are unsigned.

### x402 Trust Index

Once a day, [`trust-scan.yml`](.github/workflows/trust-scan.yml) runs the pre-payment check against every resource in
the CDP Bazaar, the MPP directory, the [GoPlausible](https://facilitator.goplausible.xyz/discovery/resources) facilitator's discovery list (x402 on Algorand, about 2,500 endpoints the Bazaar doesn't list) and [Circle's Agent Marketplace](https://agents.circle.com/services) catalog (about 2,800 endpoints, many paid through Circle Gateway) (read-only: it stops at the 402 challenge, at most two requests per host at a time, one
`/openapi.json` per origin, a User-Agent that links to `/trust`). The results roll into a 30-day history per resource,
one letter per day (`g` go, `c` caution, `n` no-go, `x` unreachable, `-` not scanned), published as
`index.json` + `summary.json` on the `trust-data` branch.
The server doesn't load that index (32 MB, ~70,000 resources): after the scan, `scripts/trust-views.js`
(`lib/trust-views.js`) writes it as small precomputed files on the same branch, from the same code (`views/meta.json`
with the summary, `views/atlas.json`, `views/templates.json`, `views/sellers.json`, the price check's word index under
`views/similar/`, one `views/networks/<key>.json` per network, and the resources in 256 buckets by key under `keys/`).
`lib/trust-reader.js` reads only what a request needs (one ~130 kB bucket per lookup, at most 32 kept) with the same
answers as the full index, and falls back to the full index while the views aren't published. Measured on the 20 Oct
index: 116 MB peak instead of 285 MB, 37 MB of heap instead of ~100 MB.
After each scan, [`hf-sync.yml`](.github/workflows/hf-sync.yml) publishes it as an open dataset on Hugging Face,
[x402Fizzl/x402-trust-index](https://huggingface.co/datasets/x402Fizzl/x402-trust-index) (CC BY 4.0): `data/endpoints.jsonl` (every endpoint in the latest scan with its
verdict, reasons, price, networks, category and history), `data/daily.csv` (go / caution / no_go per day),
`data/spot_buys.jsonl` (every purchase of the weekly spot-buy, from the `spot-data` branch), `data/onchain_payments.csv`
(signed USDC payments on Base per payout address and day, from the `payments-data` branch) and the dataset card
(`scripts/hf-export.js`). It also keeps the dataset in the Hugging Face collection "x402 agent payments" when the token
may write collections. It needs the repository secret `HF_TOKEN` (a Hugging Face write token); the variable
`HF_DATASET` overrides the dataset name.
[`hf-bench.yml`](.github/workflows/hf-bench.yml) publishes the
[x402 Agent Safety Bench](https://github.com/Fizzl13/x402-examples/tree/main/agent-safety-bench) the same way
(`scripts/hf-bench.js`): a dataset `x402-agent-safety-bench` with every run and its transcript (from x402-examples'
`bench-data` branch), the published tables as `leaderboard.csv`, and a static leaderboard Space of the same name. It
runs when the script changes, every Monday and by hand; the variable `HF_BENCH_REPO` overrides the name.
[`hf-mcp-space.yml`](.github/workflows/hf-mcp-space.yml) publishes [`hf-mcp/`](hf-mcp) as the Space
[x402Fizzl/x402-doctor](https://huggingface.co/spaces/x402Fizzl/x402-doctor): a Gradio app that is also an MCP server
(`https://x402fizzl-x402-doctor.hf.space/gradio_api/mcp/`, or added under Hugging Face's MCP settings), with four
free tools over the public API: `check_x402_endpoint` (`/api/diagnose`), `trust_record` (`/api/trust`),
`add_to_trust_index` (`POST /api/trust/submit`) and `x402_market_health` (`/api/trust/summary`). It never pays or holds a key; the variable `HF_MCP_SPACE` overrides the name.
Hugging Face hosts Gradio Spaces only for PRO accounts: without PRO the workflow warns and publishes nothing, and the
Space waits in `hf-mcp/`. Doctor's own MCP server is `https://x402-doctor.fizzl.eu/mcp`.

- The pre-payment check adds `signals.track_record` and a `caution` (`unreliable_history`) when a seller was
  payable on fewer than half of at least 3 scanned days.
- **Spot-buy sample: does "go" mean paid and delivered?** The scan only reads the 402 challenge. Once a week
  [`spot-buy.yml`](.github/workflows/spot-buy.yml) buys a small random sample of "go" endpoints (`lib/spot-buy.js`):
  x402 `exact` in USDC on Base only, one endpoint per host, never a fizzl.eu or test host, the seller's own declared
  example as the request (when it reaches the paywall), a fresh preflight with the OFAC payout screen right before
  paying, and hard caps (default 30 endpoints, $0.05 per call, $2 per run; at most 50, $0.10 and $5). Whether money
  left the wallet is measured on chain (its USDC balance before and after), and the seller's `PAYMENT-RESPONSE` is
  checked against the chain. Each result is `delivered`, `off_schema` (an answer that doesn't match the declared
  output schema), `empty`, `charged_not_delivered`, `payment_rejected`, `error_not_charged` or `payment_failed`;
  the run is appended to the `spot-data` branch (`latest.json`, `results/<date>.json`, a second run that day as `results/<date>-2.json`). It pays only with the secret
  `SPOT_BUY_KEY`, a dedicated wallet holding a few USDC; without it every run is a dry run that pays nothing.
  The latest run is on `/trust` ("Paid and delivered?") and at `GET /api/trust/spot` (summary and every purchase, no
  wallet details); `GET /api/trust?url=…` adds `spot_buy` when that endpoint was bought in it (`lib/spot-results.js`).
  The paid pre-payment check adds the same as `signals.spot_buy`, and a `caution` (`charged_without_answer`) when the
  endpoint took the payment for the example request its own listing declares and answered with an error or not within
  90 seconds. Each purchase also records its answer time (`answer_s`, from the first request to the paid answer): the
  summary counts answers slower than 30 seconds (`slow_answers`, and `delivered_within_30s_pct`, what an agent that
  waits 30 seconds gets), and a slow one adds `slow_after_payment` (info) to the pre-payment check.
  The same wallet makes one other kind of payment, started by hand: [`index-payment.yml`](.github/workflows/index-payment.yml)
  pays our own fizzl.eu routes (`scripts/index-payment.js`), because the CDP Bazaar lists a route only after a payment
  for it settles and drops it after 30 days without one. `stale` (the default) pays each of our 16 routes whose last
  settled payment in the Bazaar is 21 days old or more (read from its public search), each at most its own price
  (`INDEX_PAYMENT.routes`); `url` pays one route once. The money goes to our own payout wallets. It publishes nothing,
  so the sample stays one of other sellers. Each run is also a self-audit of those routes: the same payment header is
  sent once more and must get a 402 ("Five Attacks on x402", attack II; a route that serves it again fails the run),
  and the settlement transaction's ERC-8021 suffix shows whether our Base Builder Code was written into it. Other
  sellers' endpoints are never replayed.
- **Sanctions screen.** Every payout address (x402 `payTo`, MPP `recipient`) is matched against the OFAC SDN list's
  digital currency addresses, from [presign-guard's free open copy](https://presign-guard.fizzl.eu/v1/sanctions) of the
  US Treasury list (`lib/sanctions.js`, refreshed every 6 hours). A listed address makes the pre-payment check `no_go`
  (`payto_sanctioned`, with the SDN entry), in the paid check and in the daily scan; `signals.sanctions` says what was
  screened and against which publication. `summary.json` counts the scanned resources that pay out to a listed address
  (`payto_sanctioned`). Without the list nothing is judged (`signals.sanctions.unavailable`).
- **Burn addresses.** A payout address nobody holds a key for, mostly a placeholder left in the config, makes that
  option unpayable: the zero address (USDC refuses the transfer), `0x000000000000000000000000000000000000dEaD`, and on
  Solana the System Program or the incinerator. The pre-payment check says `payto_burn`: `no_go` when no other option
  is payable, `caution` otherwise (a client that signs the first option it can would pay the broken one).
  `summary.json` counts them (`payto_burn`).
- **Real payments on chain.** Every hour [`onchain-payments.yml`](.github/workflows/onchain-payments.yml) reads the
  new Base blocks (`scripts/onchain-payments.js`, `lib/onchain-payments.js`) and counts, per payout address the daily
  scan saw (`paytos.json` on `trust-data`), the USDC payments the payer signed with EIP-3009
  (`transferWithAuthorization`, the way x402's exact scheme settles USDC) and from how many different wallets. Plain
  transfers, Permit2 and Circle Gateway batches don't count, and x402 Doctor's own test wallet is left out. The result,
  8 days per address, is on the `payments-data` branch. The paid pre-payment check adds `signals.onchain_payments`
  (`days`, `payments`, `payers`, `usd`, `coverage`: the share of the window's blocks that were read) and an info line
  (`onchain_payments`), e.g. "47 different wallets paid this seller's payout address on Base in the last 7 days". It
  never changes the verdict: new sellers start at zero. `GET /api/trust/summary` adds the totals over all payout
  addresses (`onchain_payments`), shown on `/trust`. Read-only, no key: `BASE_RPC_URL` is asked first when set, then
  the public node `base-rpc.publicnode.com`, which serves only about the last 10,000 blocks, so a gap of more than
  ~5 hours between runs shows up as lower `coverage`. GitHub runs the hourly schedule late (every 3.5 to 6.5 hours on
  19 Oct), so the Doctor starts the workflow every hour itself, with the `DELIVERY_DISPATCH_TOKEN` it already has.
- **The daily scan, when GitHub skips it.** The scan's schedule fires four times a day and the first run does the day,
  but GitHub drops scheduled runs when it is busy (on 21 Oct the 03:17 run never started). From 04:15 UTC, every half
  hour, the Doctor checks the scan it serves; while that is the day before's, it starts `trust-scan.yml` with
  `only_if_missing`, which stops at once if today's scan was published meanwhile and waits behind one still running
  (`lib/scan-watch.js`, at most one start per two hours, the same `DELIVERY_DISPATCH_TOKEN`).
- `GET /api/trust?url=<resource>` (free, 30/min per IP): the track record of one resource.
  `POST /api/trust/batch` with `{"urls": [...]}` (free, up to 100 URLs, 10 calls/min per IP): the same for many at once,
  in the order sent (`found: false` for a URL the index doesn't have), with the index's `days` and `updated` once at the
  top. For directories and indexers that re-test their own lists; the whole index is on the `trust-data` branch.
  `POST /api/trust/submit` with `{"url": "https://…"}` (free, 10 an hour per IP): a seller adds an endpoint no registry
  lists yet. Doctor checks that it answers 402 with a payment challenge (x402, MPP or L402) and keeps the submission in
  the usage log repo (`events/trust-submit/`); the next scan reads `GET /api/trust/submitted` and scans it into
  `submitted.json`, apart from `index.json`, so lookups and badges find it (marked `submitted: true`) while the totals,
  pages and datasets keep counting registry listings only. At most 25 per host; one that a registry lists later moves to
  the index, and one not payable on any of its last 14 scanned days drops out.
  `GET /api/trust/summary`: totals of the latest scan. `/trust`: the public page, with lookup and the scan's rules.
- `GET /api/trust/network?network=xrpl` (or an id like `xrpl:0`, free): every scanned x402 endpoint that offers a network,
  payable there today or not and why (the scan records `unpayable` networks with their first problem), grouped per
  seller site. `/xrpl`: the public status page of x402 on the XRP Ledger, with the ledger checks of each payout account. `/algorand`: the same for x402 on Algorand, with the USDC opt-in of each payout account. `/stellar`: the same for x402 on Stellar, with the USDC trustline of each payout account.
- **Distinct services and their kind.** Sellers often list the same API many times (once per coin, city or ticker),
  so endpoint counts overstate the market. Payable endpoints of one seller whose descriptions share most of their
  words (Jaccard ≥ 0.5, `lib/services.js`) count as one service; on 9 Oct 2026 the 40,451 payable endpoints were
  18,475 services, and one seller alone listed a third of them. Each service gets a category (crypto, security,
  on-chain, AI, search, finance, media, places, social, developer tools, other), chosen by TypeSafe Jev after the
  daily scan (`scripts/categorize.js`, cached per description in `categories.json` on the trust-data branch, at most
  1,500 new ones a day) and guessed from keywords until then. In `/api/trust/summary` (`services`) and
  `/api/trust/network` (`services`, `categories`, per seller `services`, per endpoint `category` and
  `same_service_endpoints`), and on `/trust`, `/algorand` and `/xrpl`.
- **Possible bait.** After the scan, the same bait check the paid preflight runs (TypeSafe Jev: an official-looking
  service of a well-known brand on a domain the brand doesn't own, or a lure with free tokens, airdrops or guaranteed
  returns) goes over every service, at most 1,000 new ones a day, cached per description in `categories.json`.
  Services Jev is sure about (≥ 0.85) are listed on `/trust` and in `/api/trust/summary` (`services.bait`: checked,
  flagged and the surest 100), and marked on their endpoints in `/api/trust/network` and on `/algorand` and `/xrpl`.
- Run it yourself: `node scripts/trust-scan.js --out trust-data --limit 200`, then `node scripts/trust-views.js --dir trust-data`.

### Weekly x402 health report

Every Monday, [`weekly-report.yml`](.github/workflows/weekly-report.yml) turns the last 7 days of the Trust Index into a
report: how many Bazaar resources are clean, payable with a caution or not payable, the most common reasons with the fix
for each, which networks payable resources accept, and what changed this week (broke, fixed, flaky, new). It names no
seller or host. The report, its numbers and drafts for X, Discord and Reddit (for a person to review and post) go to
`reports/<date>.md`, `.json` and `-posts.md` on the `weekly-reports` branch. Locally:
`node scripts/weekly-report.js --out reports [--index trust-data/index.json]`.

The same run writes a digest per network, Algorand and the XRP Ledger ([`network-digest.js`](scripts/network-digest.js)):
how many endpoints could be paid there, from how many sellers, what changed since last week (new endpoints, ones that
stopped being payable, new sellers), how many accept only that network, the median price and the biggest sellers. It
names payable sellers only; problems are counted. Files: `reports/<date>-<network>.md` and `-posts.md` (X and community
drafts), plus `reports/networks/<network>-latest.json`, the snapshot next week compares with. Locally:
`node scripts/network-digest.js --out reports [--index trust-data/index.json] [--previous reports/networks]`.

## Agent skills

Two [Agent Skills](https://agentskills.io) in [`skills/`](skills) teach a coding agent (Claude Code, Codex, Cursor and others that read `SKILL.md`) when and how to use Doctor:

- **[`x402-preflight`](skills/x402-preflight/SKILL.md)**: before the agent pays any x402 or MPP endpoint (`awal x402 pay`, x402-fetch, Privy's x402 client, mppx…), it looks up the free track record, then buys the $0.001 preflight and follows go / caution / no_go, and reports the outcome afterwards.
- **[`x402-seller-check`](skills/x402-seller-check/SKILL.md)**: after building or changing a paid endpoint, it runs the free check until it passes, and buys the $0.05 fix when a problem isn't obvious.

```sh
npx skills add Fizzl13/x402-doctor
```

### Claude Code plugin

In Claude Code, the same skills come as a plugin together with the MCP server below, and presign-guard's skill and MCP server as a second plugin. The Fizzl Agent Wallet and Ichimoku Signal have a plugin each, from [Fizzl13/fizzl-skills](https://github.com/Fizzl13/fizzl-skills), the overview of every Fizzl skill:

```
/plugin marketplace add Fizzl13/x402-doctor
/plugin install x402-doctor@fizzl
/plugin install presign-guard@fizzl
/plugin install fizzl-agent-wallet@fizzl
/plugin install ichimoku-signal@fizzl
```

The marketplace is [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). The paid tools of both MCP servers need an MCP client that pays x402; without one, the skills pay over HTTP with your own x402 client, as they describe.

## MCP server

`https://x402-doctor.fizzl.eu/mcp` is an MCP server (Streamable HTTP, stateless) for Claude, Cursor and agent frameworks, listed in the official MCP registry as `io.github.Fizzl13/x402-doctor`. Directories can read its tools without connecting from the server card at `/.well-known/mcp/server-card.json` (the same list as `tools/list`).

| Tool | Price | Returns |
|---|---|---|
| `x402_quick_check` | free, 10 calls/hour | pass/warn/fail, the number of problems and the top three |
| `x402_diagnose` | $0.01 USDC via x402 | Every check with a fix hint, as `GET /api/v1/diagnose` |
| `x402_preflight` | $0.001 USDC via x402 | go/caution/no_go before paying an endpoint, as `GET /api/v1/preflight` |
| `x402_preflight_batch` | $0.005 USDC via x402 | The preflight for up to 10 endpoints (`urls`), as `GET /api/v1/preflight/batch` |
| `x402_preflight_deep` | $0.01 USDC via x402 | The preflight plus diagnosis, history, seller and domain checks, as `GET /api/v1/preflight/deep` |
| `x402_fix` | $0.05 USDC via x402 | The code changes for your stack, as `GET /api/v1/fix` |
| `x402_delivery_check` | $0.25 USDC via x402 | One real purchase of the endpoint: a job id now, the result shortly after, as `GET /api/v1/delivery-check` |
| `x402_delivery_status` | free | The status and, once done, the result of a delivery check, as `GET /api/v1/delivery-check/{id}` |
| `verify_receipt` | free | Whether a paid answer's signed receipt is valid and for which request, as `POST /api/v1/verify` (see Signed verdicts) |
| `feedback` | free | Report a bug or a missing feature, as `POST /feedback` (below) |

The paid tools are paid inside the MCP call with the x402 MCP transport (`_meta["x402/payment"]`), on Base or Solana, at the same prices and to the same payout wallets as the HTTP routes. Invalid input is refused before payment, and a failed call is not charged. A delivery check ordered over MCP is queued only once its payment settled, like the HTTP route.

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
npx github:Fizzl13/x402-doctor https://api.example.com/v1/score --body '{"text":"hello"}'
```

Exit code `0` on pass/warn, `1` when a check fails (or on warnings with `--strict`), `2` on usage errors.
The CLI can diagnose `localhost`, so you can run it against a dev server.

## GitHub Action

Check your x402 endpoints on every push. The step fails on a broken 402, each
problem shows up as an annotation on the run and the PR, and the job summary
lists what is wrong with the fix next to it. On the
[GitHub Marketplace](https://github.com/marketplace/actions/x402-doctor-check)
as **x402 Doctor check**; a public endpoint that passes also gets a badge snippet.

```yaml
- uses: Fizzl13/x402-doctor-action@v1
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
| `ALGORAND_PAY_TO` | Algorand address that receives paid-API payments in USDC (ASA 31566704), settled by GoPlausible's facilitator (`ALGORAND_FACILITATOR_URL` overrides). The account must have opted in to USDC. Unset or `off`: no Algorand option |
| `STELLAR_FACILITATOR_KEY` | API key for OpenZeppelin's "Built on Stellar" facilitator (generate one at channels.openzeppelin.com/gen); turns on the Stellar option: paid-API payments in USDC on Stellar mainnet, fees paid by the facilitator. `STELLAR_FACILITATOR_URL` points at another facilitator (with or without the key) |
| `STELLAR_PAY_TO` | Stellar account that receives those payments; default Frits's account (it trusts USDC). The account must have a USDC trustline. `off`: no Stellar option |
| `BUILDER_CODE` | Base Builder Code (ERC-8021, minted at base.dev) declared in every paid route's 402 as the `builder-code` extension: the buyer's x402 client echoes it and the facilitator writes it into the settlement, so Base attributes the payment. Unset or not a valid code: none |
| `DOCTOR_PRICE` | Price per paid diagnosis (default `$0.01`) |
| `DOCTOR_PREFLIGHT_PRICE` | Price per pre-payment check (default `$0.001`) |
| `DOCTOR_BATCH_PRICE` | Price per batch pre-payment check, up to 10 endpoints (default `$0.005`) |
| `DOCTOR_DEEP_PRICE` | Price per deep pre-payment check (default `$0.01`) |
| `DOCTOR_FIX_PRICE` | Price per fix (default `$0.05`) |
| `FACILITATOR_URL` | x402 facilitator (default PayAI, `https://facilitator.payai.network`) |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Use Coinbase's CDP facilitator for Base (PayAI stays the fallback). Payments settled through CDP get the route listed in the CDP Bazaar |
| `CDP_VALIDATE` | `off` stops the `cdp-validate` check, which sends the checked URL to Coinbase's public validate API (`api.cdp.coinbase.com/platform/v2/x402/validate`, no key) |
| `DOCTOR_SOLANA_FACILITATOR` | With CDP keys set, Solana is settled by PayAI (CDP takes over if PayAI is down). Set to `cdp` to settle Solana through CDP too |
| `MPP_SECRET` | Turns on MPP payment (method `evm`, USDC on Base, via the same facilitator) next to x402 on the paid routes, for agents that speak MPP (mppx). Any long random string; it signs the challenge ids. Without it only x402 is offered |
| `OUTREACH_URL` / `OUTREACH_KEY` | Optional, both needed: when the free web check finds a broken endpoint (a fail) whose `/openapi.json` publishes `info.contact.email`, Doctor hands a draft e-mail to the Fizzl wallet server at `OUTREACH_URL` (`https://wallet.fizzl.eu`), authenticated with `OUTREACH_KEY` (the same long random string as there). The wallet server only makes a draft; the owner decides on Telegram or the dashboard whether it is sent. Fizzl's own hosts are skipped, and each host at most once a day. The same key lets the wallet server ask `POST /api/outreach/recheck` (`{url, ids}`) right before it mails a draft: which of its findings (web check ids or preflight reasons) are still there |
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

## Payment security (Five Attacks on x402)

[Five Attacks on x402](https://arxiv.org/abs/2605.11781) (Li, Wang and Wang, 2026) describes five ways an x402 payment can go wrong between the HTTP request and the chain, and maps each to a mitigation. How this service handles them:

| Attack | What goes wrong | Here |
|---|---|---|
| I-A Revert-grant | The answer is released before the payment is final, and the payment then fails | The answer is held until the settlement is confirmed: `@x402/express` buffers it, and the XRPL and Solana paths wait for a validated, successful transaction. A failed settlement answers 402, never the content. |
| I-B Settlement preemption | Someone who sees the payment header submits the authorization first, so the server's own settlement fails | A protocol-level issue; the paper's fix is settlement bound to the facilitator. Here the payment header only travels over HTTPS and is never logged. |
| II Replay | One payment buys several answers | Each payment is claimed once: EIP-3009 nonces on Base, a settlement cache keyed by the transaction on XRPL and Solana (an XRPL payment through t54 is also refused once its transaction is on the ledger, so a restart does not reopen it), and an MPP Tempo transfer must carry the memo of one challenge (valid for minutes) and is claimed by its hash. An XRPL payment's `InvoiceID` names this service, and credits are taken atomically. |
| III Cache and header confusion | A shared cache (CDN, proxy) stores a paid answer and serves it to someone who did not pay | 402 challenges are `Cache-Control: no-store`; paid answers carry `private` (added by `@x402/express`) or `no-store`. |
| IV Server selection | Fake or manipulated listings steer agents to the wrong seller | `openapi.json` carries an ownership proof signed by the payout wallet (x402scan), and the pre-payment check flags impersonation, bait, template farms and payout addresses on the OFAC list. |

Doctor checks other sellers for two of them as well: the paid delivery check records whether a CDN may serve the paid answer for free (III), and the pre-payment check covers IV for every endpoint a buyer is about to pay.

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
lib/request-body.js    Example POST body: the caller's, or the requestBody example from the seller's /openapi.json
lib/site-scan.js       MetaMask's site scanner verdict for the domain
lib/mcp-check.js       x402 over MCP: tools/list, unpaid tools/call, the payment requirement in the tool result
lib/networks.js        Known networks, USDC (or BNB Chain's dollar tokens) per network, address validation
lib/safe-fetch.js      SSRF-safe fetch (connect-time IP check, redirects, size cap, timeout)
bin/x402-doctor.js     CLI
public/index.html      Frontend
skills/                Agent Skills: x402-preflight (buyers) and x402-seller-check (sellers)
.claude-plugin/        Claude Code plugin marketplace: the skills plus the MCP servers of Doctor and presign-guard
test/                  node:test suites (fixture x402 servers, SSRF, CLI, API)
```

## Tests

```bash
npm test
```

The suites run the doctor against local fixture servers: a healthy v2 service (Base + Solana, Bazaar, OpenAPI,
mainnet paywall) and a broken one that reproduces the real bugs above, plus SSRF, size-cap, API and CLI tests.

## License

Copyright (C) 2026 Frits Zwager. Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only); see [LICENSE](LICENSE). If you run a modified version as a network service, you must offer its source code to the users of that service.
