# x402 Doctor

Diagnoses why an x402-payable endpoint's payment flow is broken, without needing a funded wallet.

Paste a URL, get back exactly which check failed and why — protocol discovery, whether it
returns a proper 402, protocol version (v1 vs v2), envelope shape, and whether `accepts[]`
(network, payTo, asset, amount) is actually valid. Every check is grounded in real bugs hit
while building [PlainText](https://smartcontractexplainer.onrender.com) (v1/v2 confusion, the
`envelope-header-only` compatibility warning, CAIP-2 network format, decimal-vs-atomic-unit
amount mistakes).

## Project structure

```
x402-doctor/
├── server.js          Express backend — the diagnostic checks
├── package.json
└── public/
    └── index.html      Frontend (paste a URL, see the report)
```

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3001.

## Scope

This is the read-only MVP: no funded wallet, no live payment simulation, zero financial risk.
A v2 scope exists (see project discussion) that would actually sign and submit a live minimal
payment through the target's flow to trace failures past the challenge stage (verify/settle) —
that needs a funded wallet and careful cost/risk handling, and is deliberately out of scope here.

## Safety

Fetches arbitrary user-submitted URLs server-side, so it resolves the hostname and rejects
private/internal IP ranges and `localhost` before making any request (basic SSRF guard).
