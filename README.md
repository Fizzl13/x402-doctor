# x402 Trust Index data

Written daily by `.github/workflows/trust-scan.yml` on `master`. `index/`: the 30-day history per resource,
in parts that each stay far below GitHub's file size limit (`index/meta.json` has `days[]`, the count and the
parts; each part `index/<nn>.ndjson` has one `[key, resource]` per line, and per resource `h` has one letter
per day: g go, c caution, n no-go, x unreachable, - not scanned; lib/index-files.js). `index.json` (the whole
index as one JSON) and `index.ndjson` (a header line, then the same lines) are published as well while they
stay under 90 MB, and left out after that. `views/` and `keys/`: the same index as small precomputed files (the
summary, the atlas, path templates, seller totals, the price check's word index, one view per network, a large
one in parts as listed in `views/meta.json` `network_parts`, and the resources in 256 buckets by key), which
the Doctor reads instead of the whole index (lib/trust-views.js, lib/trust-reader.js). `summary.json`: totals
of the latest scan. `categories.json`: the kind of service per description (TypeSafe Jev, keyed by
lib/services.js descKey). `paytos.json`: the payout addresses on Base and the day each was last seen, for the
hourly on-chain payment count; `paytos-solana.json` the same for USDC payout addresses on Solana, with the
facilitators that pay their fees (`fee_payers`), and `paytos-xrpl.json` for payout addresses on the XRP
Ledger, `paytos-stellar.json` for USDC payout accounts on Stellar, `paytos-algorand.json` for USDC payout addresses on Algorand, `paytos-xlayer.json` for USD₮0 or USDC payout addresses on X Layer. `namesakes.json`: brand names listed by more than one seller (lib/namesakes.js); the namesakes'
resources carry `ns` in the index. `submitted.json`: the same history for endpoints their sellers added on
Doctor (POST /api/trust/submit), kept apart from the registry listings in the index. `delivery-nohumans.json`:
the endpoints nohumans.directory bought with real USDC and got an answer from, by key, as [day of that
purchase, the listing's status, its id] (from its CC BY 4.0 catalogue); `delivery-payapi.json` the same for the
routes PayAPI Market paid once and got product from, with the listing page. See
https://x402-doctor.fizzl.eu/trust
