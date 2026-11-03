// What a preflight verdict covered, and what it didn't. "go" means "nothing wrong found in what was checked", never
// "this seller will deliver": x402 Doctor reads the 402 and the seller's record, it doesn't pay or send the buyer's
// real request. Every preflight answer says which checks ran, which couldn't, and which were never in reach, so an
// agent doesn't read "go" as more than it is (the same fields as presign-guard's /v1/check).
//
//   checked:      [{ check, what }]
//   not_checked:  [{ check, because, why, send? }]
//                 because: "unavailable"  a check that applies couldn't run this time (asking again may help)
//                          "no_data"      it ran, but there is nothing on record yet (a new seller, no purchases)
//                          "not_sent"     the request lacks a parameter it needs; `send` names it
//                          "out_of_scope" a preflight doesn't check this; `why` says what does
//   checks_complete: false when anything is "unavailable"

const PRESIGN = 'What your agent signs to pay: check the payment itself before signing with presign-guard (POST https://presign-guard.fizzl.eu/v1/check, with the 402 as x402), which compares it with these terms.';
const DELIVERY = "Whether this seller answers your request, and what the answer is worth: a preflight doesn't pay. x402 Doctor's delivery check buys it once and records what came back (GET https://x402-doctor.fizzl.eu/api/v1/delivery-check, $0.25).";

// facts: what preflight() had in hand. Each dependency (trustIndex, payments, ...) counts only when the caller gave
// it: a bulk scan without it shouldn't list it as missing.
function coverageOf(f) {
  const checked = [];
  const not = [];
  const terms = f.challenge || f.otherProtocols;

  if (terms) {
    checked.push({ check: 'payment_terms', what: "The 402 as a paying agent reads it: each option's network, token, amount and payout address, and whether a standard client could pay it." });
  } else {
    not.push(f.needsInput
      ? { check: 'payment_terms', because: 'not_sent', send: 'body', why: 'The endpoint checks its input before asking for payment, so its 402 (and everything below) wasn\'t read. Send your real request body.' }
      : { check: 'payment_terms', because: 'unavailable', why: 'No payment request could be read from the endpoint, so nothing about paying it was checked.' });
  }

  if (terms) {
    if (f.screen?.unavailable) not.push({ check: 'sanctions', because: 'unavailable', why: 'The OFAC SDN list couldn\'t be loaded, so the payout addresses weren\'t screened.' });
    else if (f.screen) checked.push({ check: 'sanctions', what: `${f.screen.screened} payout address${f.screen.screened === 1 ? '' : 'es'} against the OFAC SDN list.` });
    checked.push({ check: 'payout_address', what: 'Payout addresses that are placeholders or burn addresses (money lost).' });

    if (f.price !== null) {
      if (f.maxUsd !== undefined) checked.push({ check: 'budget', what: `The price ($${f.price}) against your max_usd ($${f.maxUsd}).` });
      else not.push({ check: 'budget', because: 'not_sent', send: 'max_usd', why: 'No max_usd: the price wasn\'t checked against a budget (only against what almost every endpoint asks).' });
      if (f.advertised !== null) checked.push({ check: 'advertised_price', what: "The price against the one the seller's own OpenAPI advertises for this route." });
    }
    if (f.lureEnabled) {
      if (f.judgement) checked.push({ check: 'bait', what: 'Whether the listing impersonates a brand or lures agents (TypeSafe Jev).' });
      else if (!f.noGo) not.push({ check: 'bait', because: 'unavailable', why: 'The bait check (TypeSafe Jev) didn\'t answer.' });
    }
    if (f.priceCheckEnabled && f.price !== null && !f.noGo) {
      if (f.priceCmp) checked.push({ check: 'price_comparison', what: 'The price against comparable services in the Trust Index.' });
      else not.push({ check: 'price_comparison', because: 'unavailable', why: 'The comparison with similar services didn\'t answer.' });
    }
  }

  if (f.trustIndexGiven) {
    if (f.track) checked.push({ check: 'track_record', what: `${f.track.days_checked} day${f.track.days_checked === 1 ? '' : 's'} of x402 Doctor's daily scan: how often it was payable, and payout address or price changes.` });
    else not.push({ check: 'track_record', because: 'no_data', why: 'Not in x402 Doctor\'s daily scan yet: no track record, and no payout address history to compare with.' });
  }
  if (f.paymentsGiven && terms) {
    if (f.onchain) checked.push({ check: 'onchain_payments', what: 'Payments on chain to the payout address: how many wallets paid it recently.' });
    else if (f.countable) not.push({ check: 'onchain_payments', because: 'no_data', why: 'No on-chain count for this payout address yet.' });
    else not.push({ check: 'onchain_payments', because: 'out_of_scope', why: 'Payments on this option\'s network and token aren\'t counted.' });
  }
  if (f.deliveryGiven || f.spotGiven) {
    if (f.bought || f.elsewhere) checked.push({ check: 'purchases', what: 'Purchases with real money by x402 Doctor or other buyers, and whether an answer came.' });
    else not.push({ check: 'purchases', because: 'no_data', why: 'Nobody we know of has bought from this endpoint with real money yet.' });
  }
  if (f.outcomesGiven && f.learned) checked.push({ check: 'agent_reports', what: 'What other agents reported after paying it.' });
  if (f.https !== undefined) checked.push({ check: 'https', what: 'Whether the 402 comes over HTTPS.' });

  not.push({ check: 'your_request', because: 'out_of_scope', why: DELIVERY });
  if (terms) not.push({ check: 'your_signature', because: 'out_of_scope', why: PRESIGN });

  return { checked, not_checked: not, checks_complete: !not.some((n) => n.because === 'unavailable') };
}

module.exports = { coverageOf };
