// Pre-payment check: "should my agent pay this x402 endpoint, and with which
// option?" A buyer-side subset of the diagnosis (challenge, accepts[],
// resource, Solana payout account) plus buyer signals: advertised vs. charged
// price, the caller's budget, HTTPS and the CDP Bazaar listing. Fast and
// cached, so an agent can call it before every unknown payment.
//
// Verdicts: "go" (safe to pay the recommended option), "caution" (payable,
// but something a careful buyer should know), "no_go" (the payment would fail
// or should not be made).

const { NETWORKS, V1_NAMES, dollarToken, isGatewayOption, burnAddress, isEvmAddress, isSolanaAddress, isXrplAddress } = require('./networks');
const { probe402, needsInput, noAnswer, hostDisabled, checkEnvelope, checkAccepts, checkResource, checkSolana, checkAlgorand, checkStellar, checkXrpl, addCheck, isNeverminedScheme, isCustomScheme, isCloudflareOption } = require('./diagnose');
const { checkLightning } = require('./lightning');
const { findExampleBody } = require('./request-body');
const { outcomeReason } = require('./outcomes');
const { parseChallenges } = require('./mpp');
const { parseL402, decodeBolt11 } = require('./l402');
const { claimsOf, lureReasons } = require('./jev-lure');
const { priceReason } = require('./jev-price');
const { namesakeReason } = require('./namesakes');
const { describeEntries } = require('./sanctions');
const { WIDE_SELLERS, paidBackNote } = require('./onchain-payments');
const { SOLANA, USDC_MINT: SOLANA_USDC } = require('./onchain-payments-solana');
const { XRPL } = require('./onchain-payments-xrpl');

// A price this many times the one the OpenAPI advertises is no_go (price_far_above_advertised); above it but below
// this is a caution (price_above_advertised).
const FAR_ABOVE_ADVERTISED = 10;

// Tempo's USDC.e (TIP-20) and the methods an MPP option can be paid with.
const TEMPO_USDCE = '0x20c000000000000000000000b9537d11c60e8b50';

const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 2000;

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
  const payout = checks.find((c) => ['solana-payout-account', 'algorand-payout-optin', 'stellar-payout-trustline', 'xrpl-payout-account', 'xrpl-payout-trustline', 'lightning-invoice', 'lightning-request-hash'].includes(c.id) && c.status === 'fail' && c.option === index);
  if (payout) problems.push(payout.message);
  // USDC, or another dollar token x402 Doctor knows there (BNB Chain's 18-decimal ones, USD₮0 on X Layer, USDG).
  const token = dollarToken(caip, accept?.asset);
  const amount = accept?.amount ?? accept?.maxAmountRequired;
  // A Nevermined plan, Cloudflare pay per crawl (a signed request from an agent registered with Cloudflare, priced in
  // cents), or any other scheme standard x402 clients don't pay: never what a standard client should pick.
  const nevermined = isNeverminedScheme(accept?.scheme);
  const cloudflare = !nevermined && isCloudflareOption(accept);
  const custom = !nevermined && !cloudflare && isCustomScheme(accept?.scheme);
  const cents = cloudflare && accept?.asset === 'USD' && /^\d+$/.test(String(amount));
  return {
    index,
    network: caip ?? null,
    network_name: net?.name ?? null,
    testnet: net?.testnet ?? null,
    scheme: accept?.scheme ?? null,
    asset: accept?.asset ?? null,
    asset_symbol: token?.symbol ?? null,
    amount: amount === undefined ? null : String(amount),
    usd: token && /^\d+$/.test(String(amount)) ? round(Number(amount) / 10 ** token.decimals) : cents ? round(Number(amount) / 100) : null,
    pay_to: accept?.payTo ?? null,
    // Solana: the facilitator that pays the network fee and submits the payment.
    ...(net?.family === 'solana' && typeof accept?.extra?.feePayer === 'string' ? { fee_payer: accept.extra.feePayer } : {}),
    payable: problems.length === 0 && !nevermined && !cloudflare && !custom,
    ...(nevermined ? { client: 'nevermined', plan_id: accept?.planId ?? null } : cloudflare ? { client: 'cloudflare' } : custom ? { client: 'custom' } : {}),
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
    if (burnAddress(r?.recipient)) problems.push(`The MPP option pays out to ${burnAddress(r.recipient)} (${r.recipient}).`);
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

// Where the money would go: every option's payTo (x402) or recipient (MPP) against the OFAC SDN list
// (lib/sanctions.js). A listed address makes its option unpayable. null when screening is off or there is
// nothing to screen; { unavailable: true } while the list can't be had (then nothing is judged).
async function screenPayTo(options, sanctions) {
  if (!sanctions?.enabled) return null;
  const addresses = [...new Set(options.map((o) => o.pay_to).filter(Boolean))];
  if (!addresses.length) return null;
  const list = await sanctions.ready().catch(() => null);
  if (!list) return { list: 'OFAC SDN', unavailable: true };
  const listed = [];
  for (const o of options) {
    const r = o.pay_to ? sanctions.check(o.pay_to) : null;
    if (!r?.listed) continue;
    o.problems.push(`The payout address ${o.pay_to} is on the OFAC SDN sanctions list (${describeEntries(r.entries)}).`);
    o.payable = false;
    listed.push({ option: o.index, network: o.network, pay_to: o.pay_to, entries: r.entries.slice(0, 2).map((e) => ({ name: e.name, programs: e.programs ?? [] })) });
  }
  return { list: 'OFAC SDN', published: list.published ?? null, screened: addresses.length, listed };
}

function verdictOf(reasons) {
  if (reasons.some((r) => r.level === 'no_go')) return 'no_go';
  if (reasons.some((r) => r.level === 'caution')) return 'caution';
  return 'go';
}

async function preflight(targetUrl, { safeFetch, method, body, preferMethod, maxUsd, network, client, rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC, bazaarIndex, trustIndex, outcomes, lure, price: priceCheck, algodFetch, horizonFetch, xrplFetch, sanctions, spot, payments, delivery } = {}) {
  const url = new URL(targetUrl);
  const checks = [];
  const reasons = [];
  const add = (level, code, message) => reasons.push({ level, code, message });

  const attempts = [];
  const probe = await probe402(url.href, safeFetch, checks, method, attempts, preferMethod, { body, findExample: (u) => findExampleBody(u, safeFetch) });
  const [advertised, bazaar, track, bought, elsewhere] = await Promise.all([
    probe ? advertisedPrice(url.href, probe.method, safeFetch) : null,
    bazaarIndex ? bazaarIndex.lookup(url.href, { waitMs: 3000 }).catch(() => null) : null,
    trustIndex ? trustIndex.lookup(url.href, { waitMs: 3000 }).catch(() => null) : null,
    spot ? spot.forUrl(url.href, { waitMs: 2000 }).catch(() => null) : null,
    delivery ? delivery.forUrl(url.href, { waitMs: 2000 }).catch(() => null) : null,
  ]);

  let challenge = null;
  let mpp = [];
  let l402 = [];
  // Only server errors (5xx; behind Cloudflare a 52x or 530 means it could not reach the origin): the server is down
  // or failing, which is not the same fix as a route that doesn't ask for payment.
  const serverDown = attempts.length > 0 && attempts.every((a) => a.status >= 500 && a.status !== 501);
  if (!probe && serverDown) {
    add('no_go', 'server_error', `The server answers with a server error (${[...new Set(attempts.map((a) => a.status))].join(', ')}): it is down or failing, so there is nothing to pay right now.`);
  } else if (!probe && needsInput(attempts)) {
    // POST answers 400/422 to an empty body: the input is checked before the 402. Not broken, but the payment terms
    // can't be read without a valid request.
    const status = attempts.filter((a) => a.method === 'POST' && (a.status === 400 || a.status === 422)).pop().status;
    add('caution', 'needs_input', body !== undefined
      ? `POST with your example body answered ${status}: the endpoint checks its input before asking for payment and refused this body, so the payment terms couldn't be checked. Check the body against its input rules.`
      : `POST answered ${status} without a valid request body: the endpoint checks its input before asking for payment, so the payment terms couldn't be checked. Send your real request with its body; the 402 comes then (or check again with body).`);
  } else if (!probe && attempts.some((a) => a.free_trial)) {
    // A free trial answered (x-free-trial) every time it was asked: a paid route, but its terms can't be read today.
    add('caution', 'free_trial', 'The endpoint answered for free during a trial, so the payment terms behind the trial couldn\'t be checked.');
  } else if (!probe && noAnswer(attempts)) {
    const tried = attempts.map((a) => `${a.method} ${a.status ?? a.error}`).join(', ');
    add('no_go', 'unreachable', `The endpoint did not answer (${tried}): it timed out or could not be reached, so there is nothing to pay right now.`);
  } else if (!probe) {
    add('no_go', 'no_402', 'The endpoint does not answer 402 Payment Required, so there is nothing to pay.');
  } else {
    challenge = await checkEnvelope(probe, checks);
    // MPP (WWW-Authenticate: Payment) next to or instead of x402.
    mpp = mppOptions(probe.res, challenge ? (challenge.accepts || []).length : 0);
    l402 = l402Options(probe.res, (challenge ? (challenge.accepts || []).length : 0) + mpp.length);
    const disabled = !challenge && !mpp.length && !l402.length && hostDisabled(probe.res);
    if (disabled) add('no_go', 'host_disabled', `The 402 comes from ${disabled.host}, not from the seller: ${disabled.host} has switched this deployment off (${disabled.code}), so there is no payment request and nothing to pay until the seller turns it back on.`);
    else if (!challenge && !mpp.length && !l402.length) add('no_go', 'invalid_challenge', 'The 402 response carries no valid x402 challenge (and no MPP or L402 challenge).');
    else if (!challenge && !mpp.length) add('info', 'l402_only', "No x402 challenge: this endpoint is paid in bitcoin over Lightning (L402), so only Lightning clients can pay it (Lightning Labs' lnget, L402 SDKs). Agents that only speak x402 or MPP can't.");
    else if (!challenge) add('info', 'mpp_only', `No x402 challenge: this endpoint is paid over MPP (${[...new Set(mpp.map((o) => o.method))].join(', ')}), so only MPP clients can pay it (mppx; the Fizzl Agent Wallet pays the evm method in USDC). Agents that only speak x402 can't.`);
  }

  let options = [];
  let recommended = null;
  let price = null;
  let screen = null;
  if (challenge || mpp.length || l402.length) {
    if (challenge) {
      checkAccepts(challenge.accepts, checks);
      checkResource(challenge, probe.res.url || url.href, checks);
      await checkSolana(challenge.accepts, checks, { rpcUrl, walletCompat: false });
      await checkAlgorand(challenge.accepts, checks, { fetchImpl: algodFetch });
      await checkStellar(challenge.accepts, checks, { fetchImpl: horizonFetch });
      await checkXrpl(challenge.accepts, checks, { fetchImpl: xrplFetch });
      // Lightning (lnbtc): the invoice must be for this option and this request, signed by payTo.
      await checkLightning(challenge.accepts, checks, { networks: NETWORKS, addCheck, request: { method: probe.method, url: probe.res.url || url.href, body: probe.method === 'GET' ? '' : probe.body ?? '{}', headers: probe.method === 'GET' ? {} : { 'content-type': 'application/json' } } });
      options = (challenge.accepts || []).map((a, i) => ({ ...optionReport(a, i, checks), protocol: 'x402' }));
    }
    options = options.concat(mpp, l402);
    // A payout address on the OFAC SDN list: don't pay this seller at all, whichever option.
    screen = await screenPayTo(options, sanctions);
    const hit = screen?.listed?.[0];
    if (hit) {
      const name = options[hit.option]?.network_name;
      add('no_go', 'payto_sanctioned', `The seller's payout address ${hit.pay_to}${name ? ` (${name})` : ''} is on the OFAC SDN sanctions list: ${describeEntries(hit.entries)}. Paying it is prohibited for US persons, and most wallets and facilitators refuse it.`);
    }

    // A placeholder payout address (0x0…0, 0x…dEaD): that option fails or the money is lost. With another payable
    // option it's caution, because a client that takes the first option it can sign would pay the broken one.
    const burned = options.filter((o) => burnAddress(o.pay_to));
    if (burned.length) {
      const o = burned[0];
      const rest = options.some((x) => x.payable);
      add(rest ? 'caution' : 'no_go', 'payto_burn', `Option ${o.index}${o.network_name ? ` (${o.network_name})` : ''} pays out to ${burnAddress(o.pay_to)} (${o.pay_to}), a placeholder rather than the seller's wallet: ${/^0x0{40}$/.test(o.pay_to) ? 'USDC refuses the transfer' : 'the money would be lost'}.${rest ? ' Pay only through another option.' : ''}`);
    }

    const resourceCheck = checks.find((c) => c.id === 'resource-url');
    if (resourceCheck?.status === 'fail') add('caution', 'resource_mismatch', resourceCheck.message);
    else if (resourceCheck?.status === 'warn' && /differs/.test(resourceCheck.message)) add('caution', 'resource_mismatch', resourceCheck.message);

    // x402 first: most agents speak it. MPP options only when no x402 option is payable.
    const payable = options.filter((o) => o.payable);
    let candidates = payable.some((o) => o.protocol === 'x402') ? payable.filter((o) => o.protocol === 'x402') : payable;
    // Only Nevermined plans: not broken, just not payable with a standard client, and priced in the plan.
    const plans = options.filter((o) => o.client === 'nevermined' && o.problems.length === 0);
    const customs = options.filter((o) => o.client === 'custom' && o.problems.length === 0);
    const crawls = options.filter((o) => o.client === 'cloudflare' && o.problems.length === 0);
    if (candidates.length === 0 && crawls.length && !plans.length && !customs.length) {
      const usd = crawls.map((o) => o.usd).filter((x) => x !== null).sort((a, b) => a - b)[0];
      add('caution', 'cloudflare_crawler_only', `Only Cloudflare pay-per-crawl options${usd !== undefined ? ` ($${usd} a request)` : ''}: paid with a request signed by a crawler or agent registered with Cloudflare (Web Bot Auth), which Cloudflare bills later. A standard x402 client or wallet can't pay it, so pay only if your agent has that registration.`);
      if (usd !== undefined && maxUsd !== undefined && usd > maxUsd) add('no_go', 'over_budget', `The cheapest option costs $${usd}, above your max_usd of $${maxUsd}.`);
    } else if (candidates.length === 0 && customs.length && !plans.length) {
      add('caution', 'custom_scheme_only', `Only options in a scheme standard x402 clients and wallets don't pay (${[...new Set(customs.map((o) => o.scheme))].map((x) => `"${String(x).slice(0, 40)}"`).join(', ')}): only a client built for it can pay, and x402 Doctor can't check what it requires, so max_usd is not checked.`);
    } else if (candidates.length === 0 && plans.length) {
      add('caution', 'nevermined_plan', `Only Nevermined plan options (plan ${String(plans[0].plan_id).slice(0, 12)}…): paid through Nevermined's facilitator from credits in that plan, with a Nevermined account and its SDK or CLI. A standard x402 client or wallet can't pay it, and the price is in the plan, so max_usd is not checked.`);
    } else if (candidates.length === 0) {
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
    else if (candidates.length && usdc.length === 0) add('caution', 'unknown_asset', 'The payable options are not in a known USDC (or other dollar stablecoin) contract; check what token you would be paying with.');
    // Circle Gateway options are paid from a Gateway balance with Circle's client; a standard x402 client's signature
    // is refused. Recommend one only when nothing else is payable. Only Gateway: caution, like other options standard
    // clients can't pay (custom_scheme_only, nevermined_plan), unless the agent says it pays with Circle's client
    // (client=gateway): then Gateway is what it pays, and it is recommended first.
    const gatewayClient = client === 'gateway';
    const gateway = (o) => o.protocol === 'x402' && isGatewayOption(challenge?.accepts?.[o.index]);
    if (candidates.length && candidates.every(gateway)) {
      if (gatewayClient) add('info', 'gateway_only', "Only Circle Gateway options: your agent pays with Circle's Gateway client (client=gateway), so it pays them from its Gateway balance. Standard x402 clients can't.");
      else add('caution', 'gateway_only', "Only Circle Gateway options: they are paid from USDC deposited in Circle's Gateway Wallet, with Circle's Gateway client (@circle-fin/x402-batching). A standard x402 client's signature is refused, so pay only if your agent uses Circle's client and has a Gateway balance (then ask with client=gateway).");
    }
    const usable = usdc.length ? usdc : candidates;
    const preferred = gatewayClient ? gateway : (o) => !gateway(o);
    const pool = usable.some(preferred) ? usable.filter(preferred) : usable;
    // At the same price, prefer an option every x402 client can pay: not via Permit2 (a one-time approval first)
    // and without a transfer method standard clients don't know (BNB Chain's "permit2-exact"); then USDC, which most
    // agents hold, over BNB Chain's other dollar tokens.
    const friction = (o) => (o.protocol === 'x402' && checks.some((c) => c.id === `accepts[${o.index}]-permit2` || (c.id === `accepts[${o.index}]-extra` && c.status === 'warn')) ? 1 : 0);
    const notUsdc = (o) => (o.usd !== null && o.asset_symbol && o.asset_symbol !== 'USDC' && o.protocol === 'x402' ? 1 : 0);
    // A $0 quote is the price of an empty request, not of the agent's: a priced option goes first.
    const quotedZero = (o) => (/^0+$/.test(String(o.amount ?? '')) ? 1 : 0);
    const cheapest = [...pool].sort((a, b) => quotedZero(a) - quotedZero(b) || ((a.usd ?? Infinity) - (b.usd ?? Infinity)) || friction(a) - friction(b) || notUsdc(a) - notUsdc(b))[0];
    if (cheapest) recommended = cheapest.index;
    if (cheapest && quotedZero(cheapest)) add('caution', 'price_depends_on_request', "The 402 for this check's request (no body or parameters) asks $0, so the price depends on what you send. Your real request gets its own 402: check that price, and max_usd, before paying.");

    price = cheapest?.usd ?? null;
    if (price !== null && maxUsd !== undefined && price > maxUsd) {
      add('no_go', 'over_budget', `The cheapest payable option costs $${price}, above your max_usd of $${maxUsd}.`);
    }
    if (price !== null && advertised !== null && price > advertised * 1.0001) {
      // Ten times the advertised price or more is a wrong or deceptive amount, not a price change: no_go, so an agent
      // that only reads the verdict doesn't pay it. The agent safety bench saw agents pay a 1,000x caution "within the
      // budget"; every model stopped at a no_go, even without the skill.
      const times = advertised > 0 ? price / advertised : Infinity;
      if (advertised > 0 && times >= FAR_ABOVE_ADVERTISED) add('no_go', 'price_far_above_advertised', `Charges $${price} but its OpenAPI advertises $${advertised} for this route: ${Math.round(times)} times as much.`);
      else add('caution', 'price_above_advertised', `Charges $${price} but its OpenAPI advertises $${advertised} for this route.`);
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
  // Another seller, better known, lists a service under the same brand name (lib/namesakes.js): an info line only.
  const namesake = namesakeReason(track?.namesake);
  if (namesake) add(namesake.level, namesake.code, namesake.message);
  // x402 Doctor's own weekly spot-buy (lib/spot-buy.js): money taken for the seller's own example request, with an
  // error back, is a caution. With a plain request it could be our input, so that stays a signal only.
  if (bought?.result === 'charged_not_delivered' && bought.request === 'example') {
    const answer = bought.status ? `answered HTTP ${bought.status}` : bought.timed_out ? `gave no answer within ${bought.answer_s ?? 90} seconds` : 'answered with an error';
    add('caution', 'charged_without_answer', `In x402 Doctor's spot-buy of ${bought.date} this endpoint took ${bought.charged_usd != null ? `$${bought.charged_usd}` : 'the payment'} for the example request its own listing declares and ${answer}${bought.reason ? ` (${bought.reason})` : ''}.`);
  }
  // Delivered, but slowly: an agent that gives up after 30 seconds pays and gets nothing.
  if ((bought?.result === 'delivered' || bought?.result === 'off_schema') && bought.answer_s > 30) {
    add('info', 'slow_after_payment', `In x402 Doctor's spot-buy of ${bought.date} this endpoint answered ${bought.answer_s} seconds after the first request. An agent that gives up sooner pays without getting the answer: allow at least ${Math.ceil(bought.answer_s / 10) * 10 + 10} seconds.`);
  }
  // Bought with real USDC by nohumans.directory or PayAPI Market, with an answer back (lib/delivery-elsewhere.js): what
  // our read-only check can't see. Information only, never the verdict.
  if (elsewhere) add('info', 'delivered_elsewhere', `Bought with real USDC, and the answer came: ${(elsewhere.sources || [elsewhere]).map((h) => `${h.source} on ${h.paid_on}${h.status === 'failing' ? ' (failing that directory\'s checks since)' : ''}`).join(', ')}.`);
  // What other agents reported after paying this endpoint (lib/outcomes.js).
  const learned = outcomes ? outcomes.lookup(url.href) : null;
  const fromOutcomes = outcomeReason(learned);
  if (fromOutcomes) add(fromOutcomes.level, fromOutcomes.code, fromOutcomes.message);
  // Is it bait (brand impersonation, a lure, output that doesn't fit the promise)? And is the price far above
  // what comparable services ask (lib/jev-price.js: TypeSafe Jev picks the comparable ones from the Trust Index)?
  // Both opt-in, both only for an endpoint that could be paid, asked at the same time: they can add caution or
  // info, never no_go.
  let judgement = null;
  let priceCmp = null;
  if (challenge && !reasons.some((r) => r.level === 'no_go')) {
    const claims = claimsOf(challenge);
    [judgement, priceCmp] = await Promise.all([
      lure?.enabled ? lure.judge(url.hostname, claims) : null,
      priceCheck?.enabled && price !== null ? priceCheck.compare(url.href, { description: claims?.description, priceUsd: price }).catch(() => null) : null,
    ]);
    for (const r of lureReasons(judgement)) add(r.level, r.code, r.message);
    const r = priceReason(priceCmp);
    if (r) add(r.level, r.code, r.message);
  }
  // Real payments on chain (lib/onchain-payments.js): how many different wallets paid this payout address in the last
  // 7 days, on Base (signed USDC transfers) or, for a seller without a Base option, Solana (USDC transfers a
  // facilitator paid the fee for) or the XRP Ledger (RLUSD or USDC payments an x402 client marked). The recommended
  // option first within a network. A signal only: new sellers start at zero.
  const recommendedOption = recommended === null ? null : options[recommended];
  const countable = (o) => o && o.protocol !== 'l402' && !(o.protocol === 'x402' && isGatewayOption(challenge?.accepts?.[o.index])) && (
    (o.network === 'eip155:8453' && isEvmAddress(o.pay_to)) || (o.network === SOLANA && o.asset === SOLANA_USDC && isSolanaAddress(o.pay_to))
    || (o.network === XRPL && isXrplAddress(o.pay_to)));
  const candidates = [recommendedOption, ...options].filter(countable);
  const counted = candidates.find((o) => o.network === 'eip155:8453') || candidates[0];
  const onchain = payments && counted ? await payments.lookup(counted.pay_to, { waitMs: 2000 }).catch(() => null) : null;
  if (onchain) {
    const period = onchain.days === 1 ? 'yesterday' : `in the last ${onchain.days} days`;
    const sol = onchain.network === SOLANA, xrpl = onchain.network === XRPL;
    const where = sol ? 'Solana' : xrpl ? 'the XRP Ledger' : 'Base';
    const kind = sol ? 'USDC' : xrpl ? 'x402' : 'signed USDC';
    const how = sol ? 'their network fee paid by an x402 facilitator, the way x402 settles on Solana'
      : xrpl ? 'in RLUSD or USDC, each marked by the x402 client that signed it'
      : "the way x402 settles; x402 Doctor's own test purchases left out";
    // Wallets that pay many sellers are checkers and scanners: say how many of the payers were, so a count made of
    // probes doesn't read as demand.
    const wide = onchain.payers_wide || 0;
    const wideNote = !wide ? ''
      : wide >= onchain.payers ? ` ${onchain.payers === 1 ? 'That wallet' : 'All of them'} paid ${WIDE_SELLERS} or more different sellers in the same days, as checkers and scanners do: no ordinary buyer seen yet.`
      : ` ${wide} of these wallets paid ${WIDE_SELLERS} or more different sellers in the same days, as checkers and scanners do.`;
    add('info', 'onchain_payments', onchain.payments
      ? `${onchain.payers_at_least ? 'At least ' : ''}${onchain.payers} different ${onchain.payers === 1 ? 'wallet' : 'wallets'} paid this seller's payout address on ${where} ${period}: ${onchain.payments} ${kind} ${onchain.payments === 1 ? 'payment' : 'payments'}, $${onchain.usd} in total (${how}).${wideNote}${paidBackNote(onchain)}`
      : `No ${kind} payments reached this seller's payout address on ${where} ${period}. Not a problem by itself: new sellers start at zero.`);
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
      ...(bought ? { spot_buy: { date: bought.date, result: bought.result, price_usd: bought.price_usd, charged_usd: bought.charged_usd, status: bought.status, ...(bought.reason ? { reason: bought.reason } : {}), request: bought.request } } : {}),
      ...(elsewhere ? { delivered_elsewhere: elsewhere } : {}),
      ...(judgement ? { jev_lure: judgement } : {}),
      ...(priceCmp ? { price_check: priceCmp } : {}),
      ...(screen ? { sanctions: screen } : {}),
      ...(onchain ? { onchain_payments: onchain } : {}),
    },
    reasons,
    checked_at: new Date().toISOString(),
  };
}

// Results are cached per URL + method + body + budget + network for 10 minutes, so
// repeated checks before each payment are instant and cheap for the seller.
function createPreflight(deps) {
  const cache = new Map();
  return async function cachedPreflight(targetUrl, opts = {}) {
    const key = JSON.stringify([targetUrl, opts.method || null, opts.body ?? null, opts.preferMethod || null, opts.maxUsd ?? null, opts.network || null, opts.client || null]);
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
          fee_payer: { type: 'string', description: 'Solana: the facilitator that pays the network fee (extra.feePayer)' },
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
