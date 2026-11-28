'use strict';

// CCD as a second way to pay on Concordium, next to the token option (USDR) of lib/concordium-pay.js.
//
// Every paid route of the HTTP paywall that takes the token on Concordium also gets a CCD option: the same dollar
// price in CCD, at the rate Concordium itself prices transaction fees with (the chain parameter microGTUPerEuro,
// microCCD per euro, read through the wallet proxy every hour) and a euro/dollar rate (CONCORDIUM_EUR_PER_USD,
// default 0.90: the ECB's 1.1081 dollars per euro on 12 Nov 2026). The amount is rounded up to two significant digits
// (a $0.05 route: 16 CCD on 12 Nov 2026), so it holds still between a 402 and its payment unless the rate moves a lot.
// Without a rate younger than a day the CCD option is left out of the 402, and the token option stays as it was.
//
// Off unless CONCORDIUM_CCD=on and the Concordium option itself is on (CONCORDIUM_PAY_TO, CONCORDIUM_FACILITATOR_URL).
// The facilitator settles CCD and tokens alike and sponsors the fee either way. Only the HTTP paywall offers CCD
// (withCcd on its routes, attach on its resource server); the MCP tools keep their fixed accepts[], as for $AFUEL.

const { CONCORDIUM_MAINNET, concordiumPayTo, TOKEN_OFF, withoutOffTokens } = require('./concordium-pay');

const WALLET_PROXY = 'https://wallet-proxy.mainnet.concordium.software';
const EUR_PER_USD = 0.9;
const REFRESH_MS = 60 * 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;
/** Marks the CCD options, so attach() can price them, or leave them out while there is no rate. */
const CCD_OPTION = Symbol.for('fizzl.ccd-option');

/** microCCD per euro from the chain parameters (microGTUPerEuro: { numerator, denominator }), or null. */
function microCcdPerEuro(params) {
  const r = params && params.microGTUPerEuro;
  const n = Number(r && r.numerator);
  const d = Number(r && r.denominator);
  const v = n / d;
  return n > 0 && d > 0 && Number.isFinite(v) && v > 0 ? v : null;
}

/** microCCD for a dollar amount, rounded up to two significant digits ("16000000" for 15.9 CCD), or null. */
function ccdAmount(usd, eurPerUsd, perEuro) {
  const micro = usd * eurPerUsd * perEuro;
  if (!(micro > 0) || !Number.isFinite(micro)) return null;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(micro)) - 1);
  return BigInt(Math.ceil(micro / step - 1e-9) * step).toString();
}

function createCcd({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const enabled = env.CONCORDIUM_CCD === 'on' && Boolean(concordiumPayTo(env));
  const eurPerUsd = Number(env.CONCORDIUM_EUR_PER_USD) > 0 ? Number(env.CONCORDIUM_EUR_PER_USD) : EUR_PER_USD;
  const proxy = String(env.CONCORDIUM_WALLET_PROXY || WALLET_PROXY).trim().replace(/\/+$/, '');
  let cache = null; // { at, perEuro }
  let inflight = null;

  async function refresh() {
    try {
      const res = await fetchImpl(`${proxy}/v0/chainParameters`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`wallet proxy HTTP ${res.status}`);
      const perEuro = microCcdPerEuro(await res.json());
      if (!perEuro) throw new Error('no microGTUPerEuro in the chain parameters');
      cache = { at: now(), perEuro };
    } catch (err) {
      console.error('CCD rate refresh failed:', err.message);
    }
  }

  /** Reads the chain's rate again when it is older than an hour. Never throws. */
  async function ensureRate() {
    if (!enabled) return;
    if (cache && now() - cache.at < REFRESH_MS) return;
    inflight ??= refresh().finally(() => { inflight = null; });
    await inflight;
  }

  const perEuro = () => (cache && now() - cache.at <= MAX_AGE_MS ? cache.perEuro : null);

  /** Dollars per whole CCD, or null without a rate (the usage log values CCD payments with it). */
  function usdPerCcd() {
    const r = perEuro();
    return r ? 1e6 / (r * eurPerUsd) : null;
  }

  /** The x402 price of a dollar amount in CCD, or null without a rate. */
  async function priceFor(usd) {
    await ensureRate();
    const r = perEuro();
    const amount = r ? ccdAmount(usd, eurPerUsd, r) : null;
    return amount ? { amount, asset: 'CCD', extra: { decimals: 6 } } : null;
  }

  /** The CCD option after a Concordium token option (its amount is the route's dollar price, 6 decimals), or null. */
  function optionFor(tokenOption) {
    const amount = tokenOption && tokenOption.price && tokenOption.price.amount;
    if (!/^\d+$/.test(String(amount ?? ''))) return null;
    const usd = Number(amount) / 1e6;
    return {
      scheme: 'exact',
      network: CONCORDIUM_MAINNET,
      payTo: tokenOption.payTo,
      maxTimeoutSeconds: tokenOption.maxTimeoutSeconds,
      price: async () => {
        const price = await priceFor(usd);
        if (!price) throw new Error('no CCD rate');
        return price;
      },
      [CCD_OPTION]: () => priceFor(usd),
    };
  }

  /** Routes config with a CCD option after every Concordium token option, or in its place when the token is off
   *  (CONCORDIUM_TOKEN=off). With CCD off, a token marked off is simply left out. */
  function withCcd(routes) {
    return Object.fromEntries(Object.entries(routes).map(([key, route]) => {
      if (!Array.isArray(route?.accepts)) return [key, route];
      if (!enabled) return [key, { ...route, accepts: withoutOffTokens(route.accepts) }];
      const accepts = route.accepts.flatMap((a) => {
        const token = a?.network === CONCORDIUM_MAINNET && a.scheme === 'exact' && a.price && typeof a.price === 'object' && String(a.price.asset).toUpperCase() !== 'CCD';
        const extra = token ? optionFor(a) : null;
        if (a && a[TOKEN_OFF]) return extra ? [extra] : [];
        return extra ? [a, extra] : [a];
      });
      return [key, { ...route, accepts }];
    }));
  }

  // x402 builds accepts[] from every option and fails the whole 402 when one price can't be resolved; this prices the
  // CCD options, or leaves them out (the token and the other networks stay) while there is no rate.
  function attach(resourceServer) {
    if (!enabled) return resourceServer;
    const build = resourceServer.buildPaymentRequirementsFromOptions.bind(resourceServer);
    resourceServer.buildPaymentRequirementsFromOptions = async (options, context) => {
      const kept = [];
      for (const option of options) {
        if (!option?.[CCD_OPTION]) { kept.push(option); continue; }
        const price = await option[CCD_OPTION]();
        if (price) kept.push({ scheme: option.scheme, network: option.network, payTo: option.payTo, maxTimeoutSeconds: option.maxTimeoutSeconds, price });
      }
      return build(kept, context);
    };
    return resourceServer;
  }

  return {
    enabled,
    eurPerUsd,
    withCcd,
    attach,
    ensureRate,
    usdPerCcd,
    priceFor,
    status: () => (enabled ? { on: true, eurPerUsd, ...(cache ? { microCcdPerEuro: Math.round(cache.perEuro), usdPerCcd: usdPerCcd(), ageMs: now() - cache.at } : { microCcdPerEuro: null }) } : { on: false }),
  };
}

module.exports = { CCD_OPTION, microCcdPerEuro, ccdAmount, createCcd };
