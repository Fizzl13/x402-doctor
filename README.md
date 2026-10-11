# x402 Trust Index data

Written daily by `.github/workflows/trust-scan.yml` on `master`. `index.json`: 30-day history per
resource (`days[]`, and per resource `h` with one letter per day: g go, c caution, n no-go,
x unreachable, - not scanned). `summary.json`: totals of the latest scan. `categories.json`: the kind of
service per description (TypeSafe Jev, keyed by lib/services.js descKey). See https://x402-doctor.fizzl.eu/trust
