// Spot-buy sample: does "looks payable" turn into "paid and delivered"?
//
// The Trust Index only reads the 402 challenge; it never pays. Once a week this buys a small random sample of
// endpoints the index calls "go", with a dedicated wallet and hard caps, and records what happened after paying:
// delivered, an empty or off-schema answer, a refused payment, or money taken without an answer.
//
// Only x402 "exact" in USDC on Base. One endpoint per host, never a fizzl.eu service or a test/staging host.
// Right before paying: a fresh preflight (same checks as the paid one, including the OFAC screen of the payout
// address) must say go, the price must be under the per-call cap and fit the run's budget. The request is the
// seller's own declared example (Bazaar info.input) when there is one, and only if that example answers 402.
// Whether money left the wallet is measured on chain (the wallet's USDC balance before and after), not taken
// from the seller's word; the seller's PAYMENT-RESPONSE header is checked against the chain as well.

const dns = require('dns').promises;
const { probe402, checkEnvelope, declaredRequest, schemaErrors } = require('./diagnose');
const { preflight } = require('./preflight');
const { testByAddress } = require('./jev-triage');
const { isPrivateIp } = require('./safe-fetch');

const BASE = 'eip155:8453';
const USER_AGENT = 'x402-doctor-spot-buy/1.0 (+https://x402-doctor.fizzl.eu/trust; buys a small random sample of endpoints once a week)';
const DEFAULTS = { n: 30, capUsd: 0.05, budgetUsd: 2 };
const LIMITS = { n: 50, capUsd: 0.1, budgetUsd: 5 }; // hard ceilings, whatever the settings say
const OWN_HOST = /(^|\.)fizzl\.eu$/i;
const MAX_BODY = 512 * 1024;

// Outcomes after a purchase was attempted. "Paid and delivered" = delivered + off_schema (an answer came back).
const OUTCOMES = {
  delivered: 'Paid; a 2xx answer with content (matching the declared output schema when there is one)',
  off_schema: 'Paid; a 2xx answer that does not match the declared output schema',
  empty: 'Paid; a 2xx answer without content',
  charged_not_delivered: 'USDC left the wallet, but the answer was an error',
  payment_rejected: 'The seller answered 402 again after the payment was sent',
  error_not_charged: 'An error answer after paying, and no USDC left the wallet',
  payment_failed: 'No payment could be made (no usable option, signing or network error)',
};

function seededRandom(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// ISO week, e.g. "2026-W42" (kept for reference; the default seed is the run's date, so two runs in one week, a
// manual one and the Sunday one, don't buy the same sample).
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

// The candidates: x402 resources judged "go" in the latest scan, payable on Base, priced above 0 and at most the
// cap, on https, not ours, not a test host. One random resource per host, hosts in random order, the first n.
// The seed (default: today's date, UTC) makes the sample reproducible: anyone can redraw it from the same index.
function selectCandidates(index, { n = DEFAULTS.n, capUsd = DEFAULTS.capUsd, seed = new Date().toISOString().slice(0, 10) } = {}) {
  const byHost = new Map();
  for (const [key, r] of Object.entries(index?.resources || {})) {
    const url = r.url || key;
    const host = hostOf(url);
    const last = r.last || {};
    if (!host || r.p === 'mpp' || !String(r.h || '').endsWith('g')) continue;
    if (!url.startsWith('https://') || OWN_HOST.test(host) || testByAddress(url)) continue;
    if (!(last.price_usd > 0 && last.price_usd <= capUsd) || !(last.networks || []).includes(BASE)) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push({ url, method: r.method || null, price_usd: last.price_usd, host });
  }
  const rnd = seededRandom(seed);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const hosts = shuffle([...byHost.keys()].sort());
  const picks = hosts.slice(0, n).map((h) => { const list = byHost.get(h).sort((a, b) => a.url.localeCompare(b.url)); return list[Math.floor(rnd() * list.length)]; });
  return { pool: { hosts: byHost.size, resources: [...byHost.values()].reduce((s, l) => s + l.length, 0) }, seed, picks };
}

// A public host only: the catalogs are public, but a listing could point anywhere.
async function publicHost(host, lookup = dns.lookup) {
  const addrs = await lookup(host, { all: true });
  return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
}

// The request the seller's own Bazaar listing describes (info.input): with a routeTemplate the Doctor's
// declaredRequest() fills the path; without one (most listings) the listed URL with the example's query parameters,
// method and JSON body. null when the listing declares no input.
function exampleRequest(url, bazaar) {
  const input = bazaar?.info?.input;
  if (!input || typeof input !== 'object') return null;
  if (bazaar.routeTemplate) return declaredRequest(new URL(url).origin, bazaar);
  const u = new URL(url);
  for (const [k, v] of Object.entries(input.queryParams || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const method = String(input.method || 'GET').toUpperCase();
  const request = { url: u.href, method };
  if (input.body !== undefined && method !== 'GET') {
    request.headers = { 'content-type': 'application/json' };
    request.body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
  }
  return request;
}

// USDC the payer sent in the settlement transaction, as the chain recorded it (checkSettlement's lookup). null when the
// transaction wasn't found, failed, or moved no USDC from the payer.
function paidOnChain(proof) {
  const chain = proof?.onchain;
  if (!chain?.found || !chain.ok) return null;
  const payer = String(proof.decoded?.payer || '').toLowerCase();
  const usdc = (chain.transfers || []).filter((t) => t.token === 'USDC' && typeof t.amount === 'number' && (!payer || String(t.from).toLowerCase().split(', ').includes(payer)));
  return usdc.length ? round6(usdc.reduce((sum, t) => sum + t.amount, 0)) : null;
}

// What the seller should send back, from its declared output schema (Bazaar), if any.
function outputSchemaOf(challenge) {
  const s = challenge?.extensions?.bazaar?.schema?.properties?.output?.properties?.example;
  return s && s.properties ? s : null;
}

function classify({ status, body, outputSchema, chargedUsd }) {
  if (status >= 200 && status < 300) {
    if (!body || !String(body).trim()) return 'empty';
    if (outputSchema) {
      let json; try { json = JSON.parse(body); } catch { return 'off_schema'; }
      return schemaErrors(outputSchema, json).length ? 'off_schema' : 'delivered';
    }
    return 'delivered';
  }
  if (status === 402) return chargedUsd > 0 ? 'charged_not_delivered' : 'payment_rejected';
  return chargedUsd > 0 ? 'charged_not_delivered' : 'error_not_charged';
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// What a seller said when it answered with an error: the x402 PaymentRequired "error" on a 402, else an
// error/message/detail field of a JSON body, else the start of the body. Short, on one line, no control characters.
function reasonOf(res, body) {
  const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const header = res.headers.get('payment-required');
  if (header) {
    try { const pr = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); if (pr.error) return clean(pr.error); } catch { /* not base64 JSON */ }
  }
  try {
    const j = JSON.parse(body);
    for (const k of ['error', 'message', 'detail', 'reason']) {
      const v = j?.[k];
      if (typeof v === 'string' && v.trim()) return clean(v);
      if (v && typeof v === 'object' && typeof v.message === 'string') return clean(v.message);
    }
  } catch { /* not JSON */ }
  return body ? clean(body) : null;
}
const readBody = async (res) => { const t = await res.text(); return t.length > MAX_BODY ? t.slice(0, MAX_BODY) : t; };

// One candidate: probe, pick the request, preflight, pay (unless dry), measure.
async function buyOne(c, deps, state) {
  const { safeFetch, payFetch, sanctions, balance, settlement, capUsd, allowPrivate, lookup, wait } = deps;
  const out = { url: c.url, host: c.host, listed_price_usd: c.price_usd };
  const probe = await probe402(c.url, safeFetch, [], c.method || null).catch(() => null);
  if (!probe) return { ...out, step: 'probe', result: 'not_402_now' };
  const challenge = await checkEnvelope(probe, []);
  if (!challenge) return { ...out, step: 'probe', result: 'no_challenge' };

  // The seller's declared example when it reaches the paywall; else the plain request the scan made.
  let request = { url: c.url, method: probe.method, headers: probe.method === 'GET' ? {} : { 'content-type': 'application/json' }, body: probe.method === 'GET' ? undefined : '{}' };
  const bazaar = challenge.extensions?.bazaar;
  // source: "example" = the seller's declared example; "plain" = no usable example (none declared, or it didn't
  // answer 402), so an error after paying most likely means the seller wants input its listing doesn't describe.
  let source = 'plain';
  const declared = exampleRequest(c.url, bazaar);
  if (declared) {
    const replay = await safeFetch(declared.url, { method: declared.method, headers: declared.headers, body: declared.body }).catch(() => null);
    if (replay?.status === 402) { request = { ...declared, headers: declared.headers || {} }; source = 'example'; }
  }
  out.request = { method: request.method, url: request.url, source, input_declared: Boolean(bazaar?.info?.input) };

  const pf = await preflight(request.url, { safeFetch, method: request.method, network: BASE, maxUsd: capUsd, sanctions });
  const best = pf.recommended_option === null ? null : pf.options[pf.recommended_option];
  out.preflight = { verdict: pf.verdict, codes: pf.reasons.filter((r) => r.level !== 'info').map((r) => r.code) };
  if (pf.verdict !== 'go' || !best || best.network !== BASE || best.usd === null) return { ...out, step: 'preflight', result: 'not_go_now' };
  out.price_usd = best.usd;
  out.pay_to = best.pay_to;
  if (best.usd > capUsd) return { ...out, step: 'price', result: 'over_cap' };
  if (state.spent + best.usd > state.budget + 1e-9) return { ...out, step: 'budget', result: 'over_budget' };
  if (!allowPrivate && !(await publicHost(c.host, lookup).catch(() => false))) return { ...out, step: 'host', result: 'not_public' };
  if (!payFetch) { state.spent += best.usd; return { ...out, step: 'dry_run', result: 'would_buy' }; }

  const before = await balance();
  if (before !== null && before < Math.round(best.usd * 1e6)) return { ...out, step: 'wallet', result: 'wallet_empty' };
  const started = Date.now();
  let res;
  try {
    res = await payFetch(request.url, { method: request.method, headers: { ...request.headers, 'user-agent': USER_AGENT }, body: request.body, signal: AbortSignal.timeout(45_000) });
  } catch (err) {
    const after = await balance().catch(() => before);
    const charged = before !== null && after !== null ? round6((before - after) / 1e6) : null;
    if (charged > 0) state.spent += charged;
    return { ...out, step: 'pay', result: charged > 0 ? 'charged_not_delivered' : 'payment_failed', error: String(err.message).slice(0, 200), charged_usd: charged, ms: Date.now() - started };
  }
  const body = await readBody(res).catch(() => '');
  const header = res.headers.get('payment-response') || res.headers.get('x-payment-response');
  // Settlement can land a moment after the answer: look a few times before concluding nothing moved.
  let after = await balance();
  for (let i = 0; i < 3 && before !== null && after === before && res.status < 500; i++) { await wait(3000); after = await balance(); }
  const proof = header ? await settlement(header).catch(() => null) : null;
  let charged = before !== null && after !== null ? round6((before - after) / 1e6) : null;
  // The balance rose: USDC came in during the purchase (a top-up), so the difference says nothing about the payment.
  // Then the settlement transaction's own USDC transfer counts, when the chain confirmed it; else the charge is unknown.
  const incoming = charged !== null && charged < 0;
  if (incoming) charged = paidOnChain(proof);
  state.spent += charged ?? best.usd;
  const result = classify({ status: res.status, body, outputSchema: outputSchemaOf(challenge), chargedUsd: charged ?? 0 });
  return {
    ...out,
    step: 'paid',
    result,
    status: res.status,
    charged_usd: charged,
    ...(incoming ? { balance_note: 'USDC came into the wallet during this purchase; charged_usd is the settlement transaction\'s transfer' + (charged === null ? ' (not found on chain: unknown)' : '') } : {}),
    body_bytes: Buffer.byteLength(body || ''),
    ...(res.status >= 300 ? { reason: reasonOf(res, body) } : {}),
    proof: proof ? { overall: proof.overall, transaction: proof.decoded?.transaction || null, explorer: proof.explorer || null } : null,
    ms: Date.now() - started,
  };
}

// The whole run. payFetch null = dry run: everything up to the payment, nothing paid.
async function runSpotBuy(candidates, { safeFetch, payFetch = null, sanctions = null, balance = async () => null, settlement = async () => null, capUsd = DEFAULTS.capUsd, budgetUsd = DEFAULTS.budgetUsd, allowPrivate = false, lookup, wait = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  capUsd = Math.min(capUsd, LIMITS.capUsd);
  budgetUsd = Math.min(budgetUsd, LIMITS.budgetUsd);
  const state = { spent: 0, budget: budgetUsd };
  const results = [];
  for (const c of candidates.slice(0, LIMITS.n)) {
    if (state.spent >= budgetUsd) { results.push({ url: c.url, host: c.host, step: 'budget', result: 'over_budget' }); continue; }
    let r;
    try {
      r = await buyOne(c, { safeFetch, payFetch, sanctions, balance, settlement, capUsd, allowPrivate, lookup, wait }, state);
    } catch (err) {
      r = { url: c.url, host: c.host, step: 'error', result: 'check_error', error: String(err.message).slice(0, 200) };
    }
    results.push(r);
    log(`${r.result.padEnd(22)} ${r.price_usd ?? ''} ${c.url}`);
    if (r.result === 'wallet_empty' || (r.result === 'payment_failed' && /insufficient|balance/i.test(r.error || ''))) { log('wallet is out of funds: stopping'); break; }
  }
  return { results, summary: summarize(results, state.spent, Boolean(payFetch)) };
}

function summarize(results, spent, live) {
  const count = (k) => results.filter((r) => r.result === k).length;
  // Bought = a payment went out (an answer came back after it, or USDC left the wallet); payment_failed is not.
  const bought = results.filter((r) => r.step === 'paid' || r.result === 'charged_not_delivered').length;
  const answered = count('delivered') + count('off_schema');
  const lost = results.filter((r) => r.result === 'charged_not_delivered');
  const errs = results.filter((r) => r.result === 'error_not_charged');
  return {
    live,
    sampled: results.length,
    skipped_before_paying: Object.fromEntries(['not_402_now', 'no_challenge', 'not_go_now', 'over_cap', 'over_budget', 'not_public', 'wallet_empty', 'check_error'].map((k) => [k, count(k)]).filter(([, v]) => v)),
    ...(live ? {
      bought,
      outcomes: Object.fromEntries(Object.keys(OUTCOMES).map((k) => [k, count(k)])),
      paid_and_delivered_pct: bought ? Math.round((answered / bought) * 1000) / 10 : null,
      charged_without_answer: { count: lost.length, usd: round6(lost.reduce((s, r) => s + (r.charged_usd || 0), 0)) },
      // Errors after paying (not charged), split by request: without a usable example they most likely mean the
      // seller wants input its listing doesn't describe; with the seller's own example they are the seller's fault.
      errors_not_charged: { with_example: errs.filter((r) => r.request?.source === 'example').length, without_example: errs.filter((r) => r.request?.source === 'plain').length },
    } : { would_buy: count('would_buy') }),
    spent_usd: round6(spent),
  };
}

module.exports = { selectCandidates, runSpotBuy, classify, summarize, reasonOf, exampleRequest, isoWeek, seededRandom, publicHost, OUTCOMES, DEFAULTS, LIMITS, USER_AGENT, BASE };
