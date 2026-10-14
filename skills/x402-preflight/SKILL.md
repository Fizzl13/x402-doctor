---
name: x402-preflight
description: "Check an x402 or MPP paid API before paying it. Use before any payment to an HTTP 402 endpoint, whether through awal x402 pay, x402-fetch, wrapFetchWithPayment, Privy's x402 client, mppx or any other client. Also use when the user asks whether a paid API is safe, works, actually delivers, or is worth its price. First a free 30-day track record, then a $0.001 go / caution / no_go verdict with the reasons and the payment option that will settle."
license: MIT
allowed-tools: ["Bash(curl *)"]
---

# Check before you pay (x402 Doctor)

Of the 36,000-odd listed x402 endpoints, on a typical day about 4% don't take a payment at all and another 3% have a problem worth a caution, and which ones changes from day to day. And "it asks for payment" is not "it delivers": in the latest weekly sample purchase, 23 of 29 endpoints that looked fine delivered what was asked. A check costs nothing or $0.001, so check first.

x402 Doctor never pays the endpoint you ask about. Its checks only read the 402 challenge, the seller's listing and its history.

## 1. Free: the track record

```bash
curl -s "https://x402-doctor.fizzl.eu/api/trust?url=<endpoint, URL-encoded>"
```

The answer covers resources listed in the CDP Bazaar or the MPP directory, which are scanned once a day:

| Field | Meaning |
| --- | --- |
| `days_payable` / `days_checked` | On how many scanned days a payment would have settled. |
| `history` | One letter per day: `g` go, `c` caution, `n` no_go, `-` not judged. |
| `last_scan.verdict`, `last_scan.codes` | Today's verdict and why. |
| `last_scan.price_usd`, `last_scan.networks` | Price and payment networks. |
| `spot_buy` | Present when the endpoint was bought in the weekly sample: what came back. |

**404** means the endpoint is not in the index: it is new or unlisted. That is not a bad sign in itself, but there is no history, so do step 2.

A long run of `g` with a recent go verdict is a good sign for a small payment. For anything else, or before a larger one, do step 2.

## 2. Paid, $0.001: the verdict

```
GET https://x402-doctor.fizzl.eu/api/v1/preflight?url=<endpoint>&max_usd=<your budget>
```

- **Optional parameters:** `method=POST` when the endpoint is called with POST, and `network=<CAIP-2 id>` to check one network only (for example `eip155:8453` for Base).
- **Paying for it:** use the x402 client you already pay with. It costs $0.001 in USDC on Base, Solana or Algorand, RLUSD on the XRP Ledger, or MPP. For example, with Coinbase's Agentic Wallet:

```bash
npx awal@2.12.1 x402 pay "https://x402-doctor.fizzl.eu/api/v1/preflight?url=<endpoint, URL-encoded>&max_usd=0.05" --max-amount 1000
```

`--max-amount 1000` is $0.001 in USDC atomic units.

The answer:

| Field | Meaning |
| --- | --- |
| `verdict` | `go`, `caution` or `no_go`. `safe_to_pay` is false only for no_go. |
| `summary` | One line to show the user. |
| `reasons` | `[{ level, code, message }]`, for example `no_402`, `over_budget`, `payto_sanctioned` (the payout address is on the OFAC SDN list), `testnet_only`, `price_above_advertised`, `suspicious_amount`, or `payments_fail_after_preflight` (other buyers paid and it failed). |
| `recommended_option` | The cheapest payment option that will settle. Pay that one. |
| `receipt` | Signed by Doctor. Keep it: it proves which verdict you got, for example to explain later why you paid. |

**Several endpoints at once:** `GET /api/v1/preflight/batch?url=<a>&url=<b>` checks up to 10 for $0.005.

**Before an expensive call:** `GET /api/v1/preflight/deep?url=<endpoint>` costs $0.01. It adds the full diagnosis, the daily history, the seller's other endpoints and domain moves.

## 3. Decide

- **go:** pay, with `recommended_option`.
- **caution:** show the user the `summary` and the `reasons`. Pay only if they agree, or if the amount is within what they already approved.
- **no_go:** don't pay. Tell the user why, using the `reasons`.

## 4. After paying

**If the endpoint answers 402 again after you paid, don't pay it again.** The authorization you signed can already have been settled, even when the seller says the payment did not arrive, so every retry can cost the full price again. Stop, report `paid_failed` (below) and tell the user what you paid.

Report what happened (free, optional). Later preflights for that endpoint count the reports, so the next buyer is warned when payments to it fail.

```bash
curl -s -X POST https://x402-doctor.fizzl.eu/api/v1/outcome -H 'content-type: application/json' \
  -d '{"outcome":"paid_ok","status":200,"query":{"url":"<endpoint>","max_usd":"0.05"},"preflight":<the preflight answer, unchanged>}'
```

- **`outcome`:** `paid_ok` means it answered 2xx, `paid_failed` means it answered 402 again, `paid_error` means another error after paying.
- **`query`:** the parameters you sent to the preflight, as strings.

## Input safety

Before putting a URL in a shell command:

- Check that it starts with `https://` or `http://`.
- Reject it if it contains spaces, quotes, backticks, `;`, `|`, `&&`, `$(` or other shell metacharacters.
- URL-encode it when it goes inside another URL's query string.
- Always single-quote or double-quote the whole URL.

## Signing something other than a plain payment

The preflight covers the x402 payment itself. Before signing anything else (a token approval, a swap, a Permit, or typed data you don't recognise), check it with presign-guard:

- `POST https://presign-guard.fizzl.eu/v1/check` costs $0.01 and answers green, orange or red with the reasons.
- On green, sign. On orange, ask the user. On red, never sign.
- Docs: https://presign-guard.fizzl.eu
