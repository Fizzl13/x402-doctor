# x402 delivery checks

Written by `.github/workflows/delivery-check.yml` on `master` (see `lib/delivery-checks.js`): each result is
one paid delivery check, an x402 endpoint bought once with the example input its listing declares, by a
dedicated wallet, the charge measured on chain. `index.json` holds every result, `results/<id>.json` one each.
Status per job: https://x402-doctor.fizzl.eu/api/v1/delivery-check/<id>
