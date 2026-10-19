---
name: x402-seller-check
description: "Check your own x402 or MPP paid endpoint the way a paying agent and the registries see it, and get it fixed. Use after building or changing a paid API (x402 with @x402/express, @x402/next, @x402/hono or another server library, Circle Gateway nanopayments with @circle-fin/x402-batching (Circle's accept-agent-payments skill), Cloudflare's Monetization Gateway, Stripe's x402 support, or MPP), before listing it in the CDP Bazaar or another directory, or when agents don't pay, payments fail, or the endpoint isn't found. Free check with a fix hint per problem; $0.05 for the concrete code fix."
license: MIT
allowed-tools: ["Bash(curl *)"]
---

# Check your paid endpoint (x402 Doctor)

Most problems that stop agents from paying are invisible from your own tests:

- an invalid 402 challenge;
- a payTo or fee payer that can't settle;
- a Solana payout wallet without a USDC token account;
- a price that differs from your OpenAPI;
- a route that answers 400 before it asks for payment;
- a Cloudflare rule that only charges GET or only charges verified bots.

x402 Doctor requests your endpoint the way an agent would and stops at the 402. It never pays.

## 1. Free: every check, with a fix hint

```bash
curl -s -X POST https://x402-doctor.fizzl.eu/api/diagnose -H 'content-type: application/json' \
  -d '{"url":"<your endpoint>","method":"GET"}'
```

- `method` is `GET` or `POST`, whichever agents use to call the route.
- The free check allows 10 requests a minute.

The answer:

| Field | Meaning |
| --- | --- |
| `overall` | `pass`, `warn` or `fail`. |
| `checks` | `[{ id, status, message, hint?, group }]`. Fix every `fail` first; each one has a hint. |
| `challenge` | The 402 challenge as parsed. |
| `share_url` | Opens the same check in a browser, to show a person. |

Run it again after each change until `overall` is `pass`. Some `warn`s can be fine for your case: read the message.

## 2. When it isn't obvious: the fix as code ($0.05)

```
GET https://x402-doctor.fizzl.eu/api/v1/fix?url=<your endpoint>&method=GET&stack=<optional, e.g. express>
```

- **What you get:** for each problem, the concrete change for your stack, filled in with your own values.
- **Paying for it:** use any x402 client. It costs $0.05 in USDC on Base, Solana or Algorand, RLUSD on the XRP Ledger, or MPP. With Coinbase's Agentic Wallet: `npx awal@2.12.1 x402 pay "<the URL above, endpoint URL-encoded>" --max-amount 50000`.

`GET /api/v1/diagnose?url=…` ($0.01) returns the same checks as the free one, with a signed receipt.

## Selling through Circle Gateway

Built with `@circle-fin/x402-batching` (for example with Circle's accept-agent-payments skill)? The check knows Gateway's options on every network it serves, testnets included. What it tells you that your own test won't:

- **Who can pay you:** only buyers with USDC deposited in Circle's Gateway Wallet and Circle's client. Standard x402 clients and Coinbase's agent wallets can't. Without one, the preflight that buyers' agents run says caution (`gateway_only`). Add a plain `exact` option next to Gateway if you want every x402 agent to pay.
- **Testnet or mainnet:** the preflight that buyers' agents run says caution (`testnet_only`) until your mainnet options are live.
- **`resource.url`:** the middleware sends a path (`/summarize`); registries and some clients expect the full URL.

## 3. After it passes

- **Track record:** once your endpoint is listed in the CDP Bazaar or the MPP directory, the daily scan builds its record. Look it up for free:

  ```bash
  curl -s "https://x402-doctor.fizzl.eu/api/trust?url=<your endpoint>"
  ```

  Buyers' agents see the same record before they pay you.
- **Badge** for your README or site:

  ```markdown
  [![x402 payable](https://x402-doctor.fizzl.eu/badge.svg?url=<your endpoint, URL-encoded>)](https://x402-doctor.fizzl.eu/trust?url=<your endpoint, URL-encoded>)
  ```

- **Every seller tool on one page:** https://x402-doctor.fizzl.eu/sellers. It covers selling through Cloudflare's Monetization Gateway or Stripe, and screening who pays you against the OFAC sanctions list.

## Input safety

Before putting a URL in a shell command:

- Check that it starts with `https://` or `http://`.
- Reject it if it contains spaces, quotes, backticks, `;`, `|`, `&&` or `$(`.
- URL-encode it inside another URL's query string.
- Keep the JSON body single-quoted.
