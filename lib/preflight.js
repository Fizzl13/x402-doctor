// Pre-payment check: "should my agent pay this x402 endpoint, and with which
// option?" A buyer-side subset of the diagnosis (challenge, accepts[],
// resource, Solana payout account) plus buyer signals: advertised vs. charged
// price, the caller's budget, HTTPS and the CDP Bazaar listing. Fast and
// cached, so an agent can call it before every unknown payment.
//
// Verdicts: "go" (safe to pay the recommended option), "caution" (payable,
// but something a careful buyer should know), "no_go" (the payment would fail
// or should not be made).

const { NETWORKS } = require('./networks');
const { probe402, checkEnvelope, checkAccepts, checkResource, checkSolana } = require('./diagnose');

const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 2000;

const usd = (atomic) => Number(atomic) / 1e6;
const round = (n) => Math.round(n * 1e6) / 1e6;

// Advertised price for this path and method from /openapi.json
// (x-payment-info.price.amount in USD), or null.
async function advertisedPrice(targetUrl, method, safeFetch) {
  const url = new URL(targetUrl);
  try {
    const res = await safeFetch(`${url.origin}/openapi.json`);
    if (res.status !== 200) return null;
    const spec = JSON.parse(typeof res.text === 'function' ? await res.text() : res.text);
    for (const [path, ops] of Object.entries(spec.paths || {})) {
      const pattern = new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}/?$`);
      if (!pattern.test(url.pathname)) continue;
      const op = ops?.[String(method || 'get').toLowerCase()];
      const amount = op?.['x-payment-info']?.price?.amount;
      if (amount !== undefined && Number.isFinite(Number(amount))) return Number(amount);
    }
  } catch {
    // no or unreadable OpenAPI: nothing advertised
  }
  return null;
}

function optionReport(accept, index, checks) {
  const net = NETWORKS[accept?.network];
  const own = checks.filter((c) => c.id === `accepts[${index}]` || c.id.startsWith(`accepts[${index}]-`));
  const problems = own.filter((c) => c.status === 'fail').map((c) => c.message);
  const payout = checks.find((c) => c.id === 'solana-payout-account' && c.status === 'fail' && c.message.includes(String(accept?.payTo)));
  if (payout) problems.push(payout.message);
  const isUsdc = Boolean(net && accept?.asset === net.usdc);
  const amount = accept?.amount ?? accept?.maxAmountRequired;
  return {
    index,
    network: accept?.network ?? null,
    network_name: net?.name ?? null,
    testnet: net?.testnet ?? null,
    scheme: accept?.scheme ?? null,
    asset: accept?.asset ?? null,
    asset_symbol: isUsdc ? 'USDC' : null,
    amount: amount === undefined ? null : String(amount),
    usd: isUsdc && /^\d+$/.test(String(amount)) ? round(usd(amount)) : null,
    pay_to: accept?.payTo ?? null,
    payable: problems.length === 0,
    problems,
  };
}

function verdictOf(reasons) {
  if (reasons.some((r) => r.level === 'no_go')) return 'no_go';
  if (reasons.some((r) => r.level === 'caution')) return 'caution';
  return 'go';
}

async function preflight(targetUrl, { safeFetch, method, maxUsd, network, rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC, bazaarIndex, trustIndex } = {}) {
  const url = new URL(targetUrl);
  const checks = [];
  const reasons = [];
  const add = (level, code, message) => reasons.push({ level, code, message });

  const probe = await probe402(url.href, safeFetch, checks, method);
  const [advertised, bazaar, track] = await Promise.all([
    probe ? advertisedPrice(url.href, probe.method, safeFetch) : null,
    bazaarIndex ? bazaarIndex.lookup(url.href, { waitMs: 3000 }).catch(() => null) : null,
    trustIndex ? trustIndex.lookup(url.href, { waitMs: 3000 }).catch(() => null) : null,
  ]);

  let challenge = null;
  if (!probe) {
    add('no_go', 'no_402', 'The endpoint does not answer 402 Payment Required, so there is nothing to pay.');
  } else {
    challenge = await checkEnvelope(probe, checks);
    if (!challenge) add('no_go', 'invalid_challenge', 'The 402 response carries no valid x402 challenge.');
  }

  let options = [];
  let recommended = null;
  if (challenge) {
    checkAccepts(challenge.accepts, checks);
    checkResource(challenge, probe.res.url || url.href, checks);
    await checkSolana(challenge.accepts, checks, { rpcUrl, walletCompat: false });
    options = (challenge.accepts || []).map((a, i) => optionReport(a, i, checks));

    const resourceCheck = checks.find((c) => c.id === 'resource-url');
    if (resourceCheck?.status === 'fail') add('caution', 'resource_mismatch', resourceCheck.message);
    else if (resourceCheck?.status === 'warn' && /differs/.test(resourceCheck.message)) add('caution', 'resource_mismatch', resourceCheck.message);

    let candidates = options.filter((o) => o.payable);
    if (candidates.length === 0) {
      add('no_go', 'no_payable_option', options.length ? 'No payment option would settle: every option has a blocking problem (see options[].problems).' : 'The challenge lists no payment options.');
    }
    if (network) {
      const onNetwork = candidates.filter((o) => o.network === network);
      if (candidates.length && onNetwork.length === 0) add('no_go', 'network_not_offered', `No payable option on ${network}; offered: ${[...new Set(candidates.map((o) => o.network))].join(', ')}.`);
      candidates = onNetwork;
    }
    const mainnet = candidates.filter((o) => o.testnet === false);
    if (candidates.length && mainnet.length === 0) add('caution', 'testnet_only', 'Only testnet payment options are offered.');
    const usdc = candidates.filter((o) => o.usd !== null);
    if (candidates.length && usdc.length === 0) add('caution', 'unknown_asset', 'The payable options are not in a known USDC contract; check what token you would be paying with.');
    const pool = usdc.length ? usdc : candidates;
    const cheapest = [...pool].sort((a, b) => (a.usd ?? Infinity) - (b.usd ?? Infinity))[0];
    if (cheapest) recommended = cheapest.index;

    const price = cheapest?.usd ?? null;
    if (price !== null && maxUsd !== undefined && price > maxUsd) {
      add('no_go', 'over_budget', `The cheapest payable option costs $${price}, above your max_usd of $${maxUsd}.`);
    }
    if (price !== null && advertised !== null && price > advertised * 1.0001) {
      add('caution', 'price_above_advertised', `Charges $${price} but its OpenAPI advertises $${advertised} for this route.`);
    }
    const decimals = checks.find((c) => /-amount$/.test(c.id) && c.status === 'warn');
    if (decimals) add('caution', 'suspicious_amount', decimals.message);
  }

  // Loopback only occurs in local use (the public service refuses private addresses).
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) add('caution', 'not_https', 'The endpoint is not served over HTTPS; the payment requirements could be altered in transit.');
  // Track record from the daily trust scan: a seller that was often not
  // payable in the last 30 days is a risk even when today's check passes.
  if (track && track.days_checked >= 3 && track.payable_ratio < 0.5) {
    add('caution', 'unreliable_history', `Payable on only ${track.days_payable} of the last ${track.days_checked} daily scans.`);
  }
  if (bazaar && !bazaar.resource && !bazaar.origin) add('info', 'not_in_bazaar', 'Neither this resource nor its origin is listed in the CDP Bazaar (not a problem by itself; many new sellers are not listed yet).');

  const verdict = verdictOf(reasons);
  const best = recommended === null ? null : options[recommended];
  const summary =
    verdict === 'no_go'
      ? `Do not pay: ${reasons.find((r) => r.level === 'no_go').message}`
      : `${verdict === 'go' ? 'OK to pay' : 'Payable, with caution'}: ${best ? `$${best.usd ?? `${best.amount} atomic units`} on ${best.network_name || best.network}` : 'see options'}.${
          verdict === 'caution' ? ` ${reasons.filter((r) => r.level === 'caution').map((r) => r.message).join(' ')}` : ''
        }`;

  return {
    url: url.href,
    method: probe?.method ?? null,
    verdict,
    safe_to_pay: verdict !== 'no_go',
    summary,
    recommended_option: recommended,
    options,
    signals: {
      https: url.protocol === 'https:',
      advertised_price_usd: advertised,
      listed_in_cdp_bazaar: bazaar ? bazaar.resource : null,
      origin_in_cdp_bazaar: bazaar ? bazaar.origin : null,
      track_record: track ? { days_checked: track.days_checked, days_payable: track.days_payable, payable_ratio: track.payable_ratio, history: track.history } : null,
      x402_version: challenge?.x402Version ?? null,
    },
    reasons,
    checked_at: new Date().toISOString(),
  };
}

// Results are cached per URL + method + budget + network for 10 minutes, so
// repeated checks before each payment are instant and cheap for the seller.
function createPreflight(deps) {
  const cache = new Map();
  return async function cachedPreflight(targetUrl, opts = {}) {
    const key = JSON.stringify([targetUrl, opts.method || null, opts.maxUsd ?? null, opts.network || null]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.result, cached: true };
    const result = await preflight(targetUrl, { ...deps, ...opts });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), result });
    return { ...result, cached: false };
  };
}

const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    method: { type: ['string', 'null'] },
    verdict: { type: 'string', enum: ['go', 'caution', 'no_go'] },
    safe_to_pay: { type: 'boolean' },
    summary: { type: 'string' },
    recommended_option: { type: ['integer', 'null'] },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          network: { type: ['string', 'null'] },
          network_name: { type: ['string', 'null'] },
          asset_symbol: { type: ['string', 'null'] },
          amount: { type: ['string', 'null'] },
          usd: { type: ['number', 'null'] },
          pay_to: { type: ['string', 'null'] },
          payable: { type: 'boolean' },
          problems: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'payable', 'problems'],
      },
    },
    signals: { type: 'object' },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: { level: { type: 'string', enum: ['no_go', 'caution', 'info'] }, code: { type: 'string' }, message: { type: 'string' } },
        required: ['level', 'code', 'message'],
      },
    },
    checked_at: { type: 'string' },
    cached: { type: 'boolean' },
  },
  required: ['url', 'verdict', 'safe_to_pay', 'summary', 'options', 'reasons'],
};

module.exports = { preflight, createPreflight, advertisedPrice, PREFLIGHT_SCHEMA };
