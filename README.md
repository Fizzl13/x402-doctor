# x402 on-chain payments

Written every hour by `.github/workflows/onchain-payments.yml` on `master`. `payments.json`: per payout
address in the Trust Index, per UTC day (today and the 7 days before), the signed USDC payments on Base
(EIP-3009 transferWithAuthorization, the way x402 settles): `[count, micro-USDC, payer prefixes]`. `days`:
how many blocks of each day were read. x402 Doctor's own test wallet is left out. `payments-solana.json`:
the same for USDC payout addresses on Solana, counting payments whose network fee a facilitator from the
sellers' offers paid (the way x402 settles on Solana). `payments-xrpl.json`: the same for payout addresses on
the XRP Ledger, counting RLUSD and USDC payments an x402 client marked (SourceTag 804681468 or an InvoiceID).
`payments-stellar.json`: the same for USDC payout accounts on Stellar, counting USDC transfers (Soroban) that
another account than the payer sent, as an x402 facilitator does. `payments-algorand.json`: the same for USDC
payout addresses on Algorand, counting grouped USDC transfers whose fee another transaction paid (fee pooling,
as GoPlausible's facilitator settles), also to the addresses that facilitator paid for. `payments-xlayer.json`:
the same as on Base for payout addresses on X Layer, counting signed (EIP-3009) USD₮0 and USDC payments. `payments-monad.json`: the same
for USDC payout addresses on Monad, and `payments-polygon.json`, `payments-arbitrum.json`,
`payments-avalanche.json` and `payments-optimism.json` for USDC payout addresses on those networks.
`history/` holds the same files for the days that left them (older than today and the 7 days before), kept
35 days, so a window other than the last week can still be counted.
See https://x402-doctor.fizzl.eu/trust
