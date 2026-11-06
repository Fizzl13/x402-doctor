// Doctor's own paid routes on Concordium mainnet: x402's exact scheme there (specs/schemes/exact/scheme_exact_concordium.md),
// paid in USDR (StablR USD, a protocol-level token: 6 decimals, a deny list and no allow list, so any account can pay
// and be paid), settled by our Concordium x402 facilitator (Fizzl13/x402-examples, concordium-facilitator), which
// sponsors the fee and checks who is being paid before it signs: the payTo is the owner of x402 Doctor's own agent,
// #5120 in Concordium's Agent Registry. The buyer needs USDR and no CCD.
//
// Environment (all off unless set):
//   CONCORDIUM_PAY_TO           the mainnet account paid (Doctor's: the owner of agent #5120)
//   CONCORDIUM_FACILITATOR_URL  the mainnet facilitator (its /supported names the sponsor, extra.feePayer)
//   CONCORDIUM_ASSET            the token id paid (default USDR); CONCORDIUM_MIN_USD the lowest route price offered
//                               on Concordium (default 0.05: the sponsor pays a fee of about a cent per payment, so the
//                               cheapest routes stay off it)
// No @concordium/* package is needed here: the facilitator builds nothing for us; this side only states the option and
// copies the facilitator's sponsor into extra.feePayer.
const { HTTPFacilitatorClient } = require('@x402/core/server');

const CONCORDIUM_MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const ACCOUNT_RE = /^[1-9A-HJ-NP-Za-km-z]{50}$/;

// "$0.05" → "50000" (6 decimals), exactly.
function atomic6(price) {
  const m = /^\$?(\d+)(?:\.(\d{1,6}))?$/.exec(String(price).trim());
  if (!m) throw new Error(`unsupported price ${price}`);
  return (BigInt(m[1]) * 1000000n + BigInt((m[2] || '').padEnd(6, '0'))).toString();
}
const usd = (price) => Number(String(price).replace(/^\$/, ''));

function concordiumPayTo(env) {
  const payTo = (env.CONCORDIUM_PAY_TO || '').trim();
  return ACCOUNT_RE.test(payTo) && (env.CONCORDIUM_FACILITATOR_URL || '').trim() ? payTo : null;
}

// The Concordium option for a route at price p, or none (not configured, or a route cheaper than CONCORDIUM_MIN_USD).
function concordiumAccepts(env, p) {
  const payTo = concordiumPayTo(env);
  if (!payTo) return [];
  const min = Number(env.CONCORDIUM_MIN_USD ?? 0.05);
  if (!(usd(p) >= min)) return [];
  const asset = (env.CONCORDIUM_ASSET || 'USDR').trim();
  return [{ scheme: 'exact', price: { amount: atomic6(p), asset, extra: { decimals: 6 } }, network: CONCORDIUM_MAINNET, payTo, maxTimeoutSeconds: 120 }];
}

// The facilitator, only for Concordium mainnet (wrapped by the caller's onlyNetworks).
function concordiumFacilitatorClient(env) {
  return concordiumPayTo(env) ? new HTTPFacilitatorClient({ url: env.CONCORDIUM_FACILITATOR_URL.trim().replace(/\/+$/, '') }) : null;
}

// The resource-server side of the scheme: the price is always given as an asset amount (above), and the sponsor comes
// from the facilitator's /supported (kinds[].extra.feePayer).
class ExactConcordiumScheme {
  constructor() {
    this.scheme = 'exact';
    // The buyer signs the transfer and the facilitator submits it later: the same flow as the other signed-payload
    // schemes (@x402/core checks a scheme names one).
    this.defaultAssetTransferMethod = 'default';
    this.paymentFlows = { default: { supported: ['authorization', 'upfront'], default: 'authorization' } };
  }
  getAssetDecimals() { return 6; }
  async parsePrice(price, network) {
    if (price && typeof price === 'object' && 'amount' in price && price.asset) return { amount: String(price.amount), asset: price.asset, extra: price.extra || {} };
    throw new Error(`Concordium options need an asset amount (${network})`);
  }
  enhancePaymentRequirements(requirements, supportedKind) {
    const feePayer = supportedKind?.extra?.feePayer;
    return Promise.resolve({ ...requirements, extra: { ...(requirements.extra || {}), ...(typeof feePayer === 'string' && ACCOUNT_RE.test(feePayer) ? { feePayer } : {}) } });
  }
}

module.exports = { CONCORDIUM_MAINNET, concordiumAccepts, concordiumFacilitatorClient, concordiumPayTo, ExactConcordiumScheme, atomic6 };
