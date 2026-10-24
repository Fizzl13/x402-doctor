# x402 Trust Index data

Written daily by `.github/workflows/trust-scan.yml` on `master`. `index.json`: 30-day history per
resource (`days[]`, and per resource `h` with one letter per day: g go, c caution, n no-go,
x unreachable, - not scanned); `index.ndjson` is the same index with one resource per line (a header line,
then `[key, resource]`). `views/` and `keys/`: the same index as small precomputed files (the summary, the
atlas, path templates, seller totals, the price check's word index, one view per network, and the resources in
256 buckets by key), which the Doctor reads instead of the whole index (lib/trust-views.js,
lib/trust-reader.js). `summary.json`: totals of the latest scan. `categories.json`: the kind of
service per description (TypeSafe Jev, keyed by lib/services.js descKey). `paytos.json`: the payout addresses on
Base and the day each was last seen, for the hourly on-chain payment count. `namesakes.json`: brand names
listed by more than one seller (lib/namesakes.js); the namesakes' resources carry `ns` in the index. `submitted.json`: the same history for
endpoints their sellers added on Doctor (POST /api/trust/submit), kept apart from the registry listings in
`index.json`. See https://x402-doctor.fizzl.eu/trust
