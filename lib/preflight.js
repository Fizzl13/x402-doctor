// Pre-payment check: "should my agent pay this x402 endpoint, and with which
// option?" A buyer-side subset of the diagnosis (challenge, accepts[],
// resource, Solana payout account) plus buyer signals: advertised vs. charged
// price, the caller's budget, HTTPS and the CDP Bazaar listing. Fast and
// cached, so an agent can call it before every unknown payment.
//
// Verdicts: "go" (safe to pay the recommended option), "caution" (payable,
// but something a careful buyer should know), "no_go" (the payment would fail
// or should not be made).

const { NETWORKS, V1_NAMES, sameAsset } = require('./networks');
const { probe402, checkEnvelope, checkAccepts, checkResource, checkSolana, checkAlgorand, checkXrpl } = require('./diagnose');
const { outcomeReason } = require('./outcomes');
const { parseChallenges } = require('./mpp');
const { parseL402, decodeBolt11 } = require('./l402');
const { claimsOf, lureReasons } = require('./jev-lure');

// Tempo's USDC.e (TIP-20) and the methods an MPP option can be paid with.
const TEMPO_USDCE = '0x20c000000000000000000000b9537d11c60e8b50';

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
  // v1 challenges name networks plainly ("base"); judge them as their CAIP-2 id.
  const caip = NETWORKS[accept?.network] ? accept?.network : V1_NAMES[accept?.network] ?? accept?.network;
  const net = NETWORKS[caip];
  const own = checks.filter((c) => c.id === `accepts[${index}]` || c.id.startsWith(`accepts[${index}]-`));
  const problems = own.filter((c) => c.status === 'fail').map((c) => c.message);
  const payout = checks.find((c) => ['solana-payout-account', 'algorand-payout-optin', 'xrpl-payout-account', 'xrpl-payout-trustline'].includes(c.id) && c.status === 'fail' && c.option === index);
  if (payout) problems.push(payout.message);
  const isUsdc = Boolean(net && sameAsset(accept?.asset, net.usdc));
  const amount = accept?.amount ?? accept?.maxAmountRequired;
  return {
    index,
    network: caip ?? null,
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

// MPP options from a 402's `WWW-Authenticate: Payment` challenges (lib/mpp.js), numbered after the x402 ones.
// evm: USDC on an EVM chain (EIP-3009, paid by mppx and the Fizzl Agent Wallet); tempo: USDC.e on Tempo;
// stripe: a card through Stripe. Payable when the challenge is complete and not expired.
function mppOptions(res, startIndex, now = Date.now()) {
  const header = res?.headers?.get ? res.headers.get('www-authenticate') : null;
  if (!header) return [];
  return parseChallenges(header).filter((c) => !c.error).map((c, i) => {
    const { params, request: r } = c;
    const method = params.method || null;
    const problems = [];
    if (!params.id) problems.push('The MPP challenge has no id.');
    if (!params.realm) problems.push('The MPP challenge has no realm.');
    if (params.expires && Number.isNaN(Date.parse(params.expires))) problems.push(`The MPP challenge's expires (${String(params.expires).slice(0, 40)}) is not an ISO 8601 date, so MPP clients treat it as expired.`);
    else if (params.expires && !(Date.parse(params.expires) > now)) problems.push(`The MPP challenge expired (${params.expires}).`);
    if (params.intent && params.intent !== 'charge') problems.push(`intent "${params.intent}" (only one-off "charge" payments are judged here).`);
    let network = null, usdc = false, decimals = Number.isInteger(r?.decimals) ? r.decimals : Number.isInteger(r?.methodDetails?.decimals) ? r.methodDetails.decimals : null;
    if (method === 'evm') {
      const chainId = r?.methodDetails?.chainId;
      network = chainId ? `eip155:${chainId}` : null;
      const net = NETWORKS[network];
      usdc = Boolean(net?.usdc && String(r?.currency || '').toLowerCase() === String(net.usdc).toLowerCase());
      if (usdc) decimals = 6;
      if (!network) problems.push('The evm option has no chainId.');
    } else if (method === 'tempo') {
      network = 'tempo';
      usdc = String(r?.currency || '').toLowerCase() === TEMPO_USDCE;
      if (usdc && decimals === null) decimals = 6;
    } else if (method === 'stripe') {
      network = 'stripe';
      if (decimals === null && String(r?.currency || '').toLowerCase() === 'usd') decimals = 2;
    }
    const amount = r?.amount;
    if (!/^\d+$/.test(String(amount ?? ''))) problems.push('The MPP option has no amount (it may be priced per call at run time).');
    const usdValue = (method === 'stripe' ? String(r?.currency || '').toLowerCase() === 'usd' : usdc) && decimals !== null && /^\d+$/.test(String(amount)) ? round(Number(amount) / 10 ** decimals) : null;
    const net = NETWORKS[network];
    return {
      index: startIndex + i,
      protocol: 'mpp',
      method,
      network,
      network_name: net?.name ?? (method === 'tempo' ? 'Tempo' : method === 'stripe' ? 'Stripe (card)' : null),
      testnet: net?.testnet ?? (method === 'tempo' || method === 'stripe' ? false : null),
      scheme: method ? `mpp:${method}` : 'mpp',
      asset: r?.currency ?? null,
      asset_symbol: usdc ? (method === 'tempo' ? 'USDC.e' : 'USDC') : method === 'stripe' ? 'USD' : null,
      amount: amount === undefined ? null : String(amount),
      usd: usdValue,
      pay_to: r?.recipient ?? null,
      payable: problems.length === 0,
      problems,
    };
  });
}

// L402 options: a Lightning invoice per challenge (the L402 one when LSAT repeats it). Priced in sats, so no USD.
function l402Options(res, startIndex, now = Date.now()) {
  const header = res?.headers?.get ? res.headers.get('www-authenticate') : null;
  if (!header) return [];
  const all = parseL402(header).filter((c) => !c.error && c.params.invoice);
  const list = all.some((c) => c.scheme === 'L402') ? all.filter((c) => c.scheme === 'L402') : all;
  return list.map((c, i) => {
    const problems = [];
    let inv = null;
    try { inv = decodeBolt11(c.params.invoice); } catch (err) { problems.push(`The Lightning invoice can't be read (${err.message}).`); }
    if (!c.params.macaroon) problems.push('The L402 challenge has no macaroon.');
    if (inv && !(inv.expiresAt > now)) problems.push('The Lightning invoice has expired.');
    if (inv && inv.msat === null) problems.push('The Lightning invoice has no amount.');
    return {
      index: startIndex + i,
      protocol: 'l402',
      method: 'lightning',
      network: inv ? `lightning:${inv.network}` : 'lightning',
      network_name: inv?.network === 'bitcoin' ? 'Lightning (bitcoin)' : inv ? `Lightning (${inv.network})` : 'Lightning',
      testnet: inv ? inv.network !== 'bitcoin' : null,
      scheme: 'l402',
      asset: 'BTC',
      asset_symbol: 'sats',
      amount: inv?.msat === null || !inv ? null : String(Number(inv.msat) / 1000),
      usd: null,
      pay_to: null,
      payable: problems.length === 0,
      problems,
    };
  });
}

function verdictOf(reasons) {
  if (reasons.some((r) => r.level === 'no_go')) return 'no_go';
  if (reasons.some((r) => r.level === 'caution')) return 'caution';
  return 'go';
}

async function preflight(targetUrl, { safeFetch, method, preferMethod, maxUsd, network, rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC, bazaarIndex, trustIndex, outcomes, lure, algodFetch, xrplFetch } = {}) {
  const url = new URL(targetUrl);
  const checks = [];
  const reasons = [];
  const add = (level, code, message) => reasons.push({ level, code, message });

  const probe = await probe402(url.href, safeFetch, checks, method, [], preferMethod);
  const [advertised, bazaar, track] = await Promise.all([
    probe ? advertisedPrice(url.href, probe.method, safeFetch) : null,
    bazaarIndex ? bazaarIndex.lookup(url.href, { waitMs: 3000 }).catch(() => null) : null,
    trustIndex ? trustIndex.lookup(url.href, { waitMs: 3000 }).catch(() => null) : null,
  ]);

  let challenge = null;
  let mpp = [];
  let l402 = [];
  if (!probe) {
    add('no_go', 'no_402', 'The endpoint does not answer 402 Payment Required, so there is nothing to pay.');
  } else {
    challenge = await checkEnvelope(probe, checks);
    // MPP (WWW-Authenticate: Payment) next to or instead of x402.
    mpp = mppOptions(probe.res, challenge ? (challenge.accepts || []).length : 0);
    l402 = l402Options(probe.res, (challenge ? (challenge.accepts || []).length : 0) + mpp.length);
    if (!challenge && !mpp.length && !l402.length) add('no_go', 'invalid_challenge', 'The 402 response carries no valid x402 challenge (and no MPP or L402 challenge).');
    else if (!challenge && !mpp.length) add('info', 'l402_only', "No x402 challenge: this endpoint is paid in bitcoin over Lightning (L402), so only Lightning clients can pay it (Lightning Labs' lnget, L402 SDKs). Agents that only speak x402 or MPP can't.");
    else if (!challenge) add('info', 'mpp_only', `No x402 challenge: this endpoint is paid over MPP (${[...new Set(mpp.map((o) => o.method))].join(', ')}), so only MPP clients can pay it (mppx; the Fizzl Agent Wallet pays the evm method in USDC). Agents that only speak x402 can't.`);
  }

  let options = [];
  let recommended = null;
  if (challenge || mpp.length || l402.length) {
    if (challenge) {
      checkAccepts(challenge.accepts, checks);
      checkResource(challenge, probe.res.url || url.href, checks);
      await checkSolana(challenge.accepts, checks, { rpcUrl, walletCompat: false });
      await checkAlgorand(challenge.accepts, checks, { fetchImpl: algodFetch });
      await checkXrpl(challenge.accepts, checks, { fetchImpl: xrplFetch });
      options = (challenge.accepts || []).map((a, i) => ({ ...optionReport(a, i, checks), protocol: 'x402' }));
    }
    options = options.concat(mpp, l402);

    const resourceCheck = checks.find((c) => c.id === 'resource-url');
    if (resourceCheck?.status === 'fail') add('caution', 'resource_mismatch', resourceCheck.message);
    else if (resourceCheck?.status === 'warn' && /differs/.test(resourceCheck.message)) add('caution', 'resource_mismatch', resourceCheck.message);

    // x402 first: most agents speak it. MPP options only when no x402 option is payable.
    const payable = options.filter((o) => o.payable);
    let candidates = payable.some((o) => o.protocol === 'x402') ? payable.filter((o) => o.protocol === 'x402') : payable;
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
    if (candidates.length && usdc.length === 0 && candidates.every((o) => o.protocol === 'l402')) add('caution', 'priced_in_sats', `Priced in bitcoin (${candidates[0].amount ?? '?'} sats over Lightning), not USDC: the dollar price moves with BTC, so max_usd is not checked.`);
    else if (candidates.length && usdc.length === 0) add('caution', 'unknown_asset', 'The payable options are not in a known USDC contract; check what token you would be paying with.');
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
  // What other agents reported after paying this endpoint (lib/outcomes.js).
  const learned = outcomes ? outcomes.lookup(url.href) : null;
  const fromOutcomes = outcomeReason(learned);
  if (fromOutcomes) add(fromOutcomes.level, fromOutcomes.code, fromOutcomes.message);
  // Is it bait (brand impersonation, a lure, output that doesn't fit the promise)? TypeSafe Jev, opt-in, only
  // for an endpoint that could be paid: it can add caution or info, never no_go.
  let judgement = null;
  if (lure?.enabled && challenge && !reasons.some((r) => r.level === 'no_go')) {
    judgement = await lure.judge(url.hostname, claimsOf(challenge));
    for (const r of lureReasons(judgement)) add(r.level, r.code, r.message);
  }
  if (bazaar && !bazaar.resource && !bazaar.origin) add('info', 'not_in_bazaar', 'Neither this resource nor its origin is listed in the CDP Bazaar (not a problem by itself; many new sellers are not listed yet).');

  const verdict = verdictOf(reasons);
  const best = recommended === null ? null : options[recommended];
  const summary =
    verdict === 'no_go'
      ? `Do not pay: ${reasons.find((r) => r.level === 'no_go').message}`
      : `${verdict === 'go' ? 'OK to pay' : 'Payable, with caution'}: ${best ? `${best.usd !== null ? `$${best.usd}` : best.protocol === 'l402' ? `${best.amount} sats` : `${best.amount} atomic units`} on ${best.network_name || best.network}` : 'see options'}.${
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
      protocols: [...(challenge ? ['x402'] : []), ...(mpp.length ? ['mpp'] : []), ...(l402.length ? ['l402'] : [])],
      mpp_methods: mpp.length ? [...new Set(mpp.map((o) => o.method).filter(Boolean))] : [],
      agent_outcomes: learned,
      ...(judgement ? { jev_lure: judgement } : {}),
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
    const key = JSON.stringify([targetUrl, opts.method || null, opts.preferMethod || null, opts.maxUsd ?? null, opts.network || null]);
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
          protocol: { type: 'string', enum: ['x402', 'mpp', 'l402'] },
          method: { type: ['string', 'null'], description: 'MPP payment method (evm, tempo, stripe); absent for x402 options' },
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
