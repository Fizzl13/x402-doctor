# x402 on-chain payments

Written every hour by `.github/workflows/onchain-payments.yml` on `master`. `payments.json`: per payout
address in the Trust Index, per UTC day (today and the 7 days before), the signed USDC payments on Base
(EIP-3009 transferWithAuthorization, the way x402 settles): `[count, micro-USDC, payer prefixes]`. `days`:
how many blocks of each day were read. x402 Doctor's own test wallet is left out. `payments-solana.json`:
the same for USDC payout addresses on Solana, counting payments whose network fee a facilitator from the
sellers' offers paid (the way x402 settles on Solana). See https://x402-doctor.fizzl.eu/trust
