'use strict';

// Refunds for Concordium x402 payments that delivered nothing, kept per seller.
//
// A refund request rides on a payment-backed outcome report (lib/outcomes.js): the paying wallet (the Fizzl Agent
// Wallet does it on its own when a paid call fails or brings back nothing) sends POST /api/v1/outcome with
// payment_receipt: { receipt, tx } and refund: one of REFUND_REASONS. The receipt is checked against the chain and the
// endpoint's own 402, so a request is always about a real payment to that seller for that route, by an
// identity-verified account. Whether nothing was delivered is the payer's word; what was paid is not.
//
// A refund is a transfer back from the account that was paid (the receipt's payTo) to the account that paid, in the
// same asset, of at least the amount, best with the memo "x402refund:" + the same SHA-256 the payment's memo carries
// (refundMemo): then it names exactly this purchase. A transfer without that memo counts too; one with another
// purchase's memo does not, and one transaction refunds one purchase.
//
// How a refund is found, read-only:
//   CCD     Doctor looks for it itself in the paying account's transactions (Concordium's wallet proxy,
//           /v3/accTransactions), at most once an hour per open request, newest first back to the payment.
//   tokens  (such as USDR) the seller or the wallet sends the refund's transaction hash: POST
//           /api/v1/concordium/refund { receipt, tx, refund_tx }, read through a Concordium x402 facilitator's
//           POST /refund (Fizzl's own, never the seller's).
// Per seller account (payTo), over 30 days: refunds asked, refunded, still open, and how long a refund took.
// Nothing about the payer is shown, only counts.

const crypto = require('node:crypto');
const { canonicalReceipt, receiptProblem, checkReceiptTx, readCcdTransaction, memoText, amountText, NETWORKS } = require('./concordium-receipt');

const refundAmount = amountText; // the amount to send back, as a seller reads it

const REFUND_PREFIX = 'x402refund:';
const MAINNET = 'ccd:9dd9ca4d19e9393877d2c44b70f89acb';
const REFUND_REASONS = new Set(['payment_not_accepted', 'error_after_payment', 'not_delivered']);
const DAYS = 30; // as outcome reports and refusals (lib/outcomes.js): the same usage-log days, read once
const SCAN_EVERY_MS = 60 * 60 * 1000; // background: each open request at most once an hour
const ASKED_EVERY_MS = 2 * 60 * 1000; // when the wallet asks about one request: at most every 2 minutes
const TIMEOUT_MS = 8000;

const PAGES = 3; // of 100 transactions, newest first, to reach the payment
const ACCOUNT_RE = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const refundMemo = (r) => `${REFUND_PREFIX}${sha256(canonicalReceipt(r))}`;
// What a refund of this purchase must match: kept per request (each field short enough for the usage log).
const termsOf = (r) => ({ network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo, memo: refundMemo(r) });

// Does this transaction ({ finalized, success, sender, transfers: [{ asset, to, amount, memo }] }) refund the purchase
// `receipt` names, paid by `payer`? { valid: true, matchedBy: 'memo' | 'amount', amount, time } or { valid: false,
// reason }. The same check as concordium-facilitator/src/receipt.js checkRefund (the tests keep them equal).
function checkRefund(receipt, payer, o) {
  const problem = receiptProblem(receipt);
  if (problem) return { valid: false, reason: problem };
  return refundHolds(termsOf(receipt), payer, o);
}
function refundHolds(receipt, payer, o) {
  if (!ACCOUNT_RE.test(String(payer))) return { valid: false, reason: 'the paying account is not known' };
  if (!o) return { valid: false, reason: 'the chain does not know the refund transaction' };
  if (!o.finalized) return { valid: false, reason: 'the refund transaction is not finalized' };
  if (!o.success) return { valid: false, reason: 'the refund transaction was rejected on chain' };
  if (o.sender !== receipt.payTo) return { valid: false, reason: 'the refund was not sent by the account that was paid' };
  if (!Array.isArray(o.transfers) || o.transfers.length !== 1) return { valid: false, reason: 'the refund transaction is not exactly one transfer' };
  const t = o.transfers[0];
  if (t.to !== payer) return { valid: false, reason: 'the refund went to another account than the one that paid' };
  const ccd = receipt.asset.toUpperCase() === 'CCD';
  if (ccd ? t.asset !== 'CCD' : t.asset !== receipt.asset) return { valid: false, reason: 'the refund is in another asset' };
  if (BigInt(t.amount) < BigInt(receipt.amount)) return { valid: false, reason: 'the refund is less than was paid' };
  const memo = typeof t.memo === 'string' ? t.memo : null;
  const mine = receipt.memo;
  if (memo && memo.startsWith(REFUND_PREFIX) && memo !== mine) return { valid: false, reason: "the refund's memo names another purchase" };
  // Without this purchase's memo only a transfer back of about the price counts, at most twice what was paid: a seller
  // that later sends the buyer far more (a top-up, another deal) has not refunded this purchase.
  if (memo !== mine && BigInt(t.amount) > 2n * BigInt(receipt.amount)) return { valid: false, reason: 'without the refund memo, a transfer back of more than twice what was paid does not count as this refund' };
  return { valid: true, matchedBy: memo === mine ? 'memo' : 'amount', amount: String(t.amount), time: o.time ?? null };
}

// A token refund through a Concordium x402 facilitator's POST /refund (Fizzl's own).
async function askFacilitator(base, receipt, tx, refundTx, fetchImpl) {
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/refund`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ receipt, tx, refund_tx: refundTx }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const j = await res.json().catch(() => null);
    if (res.status === 200 && j && typeof j.valid === 'boolean') {
      return j.valid ? { valid: true, matchedBy: j.matchedBy === 'memo' ? 'memo' : 'amount', amount: String(j.amount ?? receipt.amount), time: j.time ?? null, payer: j.payer ?? null, via: 'facilitator' } : { valid: false, reason: String(j.reason || 'not valid'), via: 'facilitator' };
    }
    return { valid: false, notRead: true, reason: `the facilitator that reads token transfers answered ${res.status}${j?.reason ? ` (${j.reason})` : ''}` };
  } catch (err) {
    return { valid: false, notRead: true, reason: `the facilitator that reads token transfers could not be reached (${err?.message || err})` };
  }
}

// Does refundTx refund the payment tx made with this receipt? First the payment itself (lib/concordium-receipt.js),
// then the refund against its payer. { valid, matchedBy, amount, payer, network } or { valid: false, reason, notRead? }.
async function checkRefundTx(receipt, tx, refundTx, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const problem = receiptProblem(receipt);
  if (problem) return { valid: false, reason: problem };
  const paidTx = String(tx ?? '').toLowerCase();
  const backTx = String(refundTx ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(paidTx) || !/^[0-9a-f]{64}$/.test(backTx)) return { valid: false, reason: 'tx and refund_tx must be transaction hashes (64 hex characters)' };
  if (paidTx === backTx) return { valid: false, reason: 'the refund is the payment itself' };
  const net = NETWORKS[receipt.network];
  if (!net) return { valid: false, reason: `${receipt.network} is not Concordium mainnet or testnet` };
  if (receipt.asset.toUpperCase() !== 'CCD') {
    const base = String(env[net.facilitatorEnv] || '').trim();
    if (!/^https:\/\//.test(base)) return { valid: false, notRead: true, reason: `a token refund (${receipt.asset}) is read through a Concordium x402 facilitator, and none is configured for ${net.id}` };
    return { ...(await askFacilitator(base, receipt, paidTx, backTx, fetchImpl)), network: net.id };
  }
  const paid = await checkReceiptTx(receipt, paidTx, { fetchImpl, env });
  if (!paid.valid) return { valid: false, ...(paid.notRead ? { notRead: true } : {}), reason: paid.notRead ? paid.reason : `the payment does not hold: ${paid.reason}`, network: net.id };
  const read = await readCcdTransaction(net, backTx, fetchImpl);
  if (read.notRead) return { valid: false, notRead: true, reason: read.reason, network: net.id };
  return { ...checkRefund(receipt, paid.payer, read.outcome), payer: paid.payer, network: net.id, via: 'wallet-proxy' };
}

// A CCD refund in the paying account's own transactions (wallet proxy, newest first, back to the payment): { refundTx,
// matchedBy, amount, time } or null; { notRead, reason } when the account could not be read. terms: termsOf(receipt).
// used: refund hashes already counted for another purchase.
async function findCcdRefund(terms, tx, payer, { fetchImpl = globalThis.fetch, used = new Set() } = {}) {
  const net = NETWORKS[terms.network];
  if (!net || String(terms.asset).toUpperCase() !== 'CCD' || !ACCOUNT_RE.test(String(payer))) return null;
  let best = null;
  let from = null;
  for (let page = 0; page < PAGES; page++) {
    let j;
    try {
      const res = await fetchImpl(`${net.walletProxy}/v3/accTransactions/${payer}?order=descending&limit=100${from ? `&from=${from}` : ''}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status !== 200) return { notRead: true, reason: `Concordium's wallet proxy answered ${res.status}` };
      j = await res.json();
    } catch (err) {
      return { notRead: true, reason: `Concordium's wallet proxy could not be reached (${err?.message || err})` };
    }
    const list = Array.isArray(j?.transactions) ? j.transactions : [];
    for (const t of list) {
      if (String(t?.transactionHash || '').toLowerCase() === tx) return best; // reached the payment: only later transfers count
      const d = t?.details || {};
      if (d.outcome !== 'success' || (d.type !== 'transfer' && d.type !== 'transferWithMemo')) continue;
      const hash = String(t.transactionHash || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash) || used.has(hash)) continue;
      const c = refundHolds(terms, payer, { finalized: true, success: true, sender: d.transferSource, transfers: [{ asset: 'CCD', to: d.transferDestination, amount: String(d.transferAmount ?? '0'), memo: memoText(d.memo) }] });
      if (!c.valid) continue;
      const found = { refundTx: hash, matchedBy: c.matchedBy, amount: c.amount, time: Number.isFinite(t.blockTime) ? Math.round(t.blockTime * 1000) : null };
      if (c.matchedBy === 'memo') best = found; // the oldest with this purchase's memo wins
      else if (!best || best.matchedBy !== 'memo') best = found; // else the oldest transfer back of the amount
    }
    if (list.length < 100) break;
    from = list[list.length - 1]?.id;
    if (!from) break;
  }
  // The payment was not among the newest transactions read: nothing older can be told apart from a transfer before it.
  return best && best.matchedBy === 'memo' ? best : null;
}

// The refund requests and refunds of the last 30 days, from the usage log (route 'outcome' with input.refund, route
// 'refund'), plus what this process saw since.
function createRefunds({ usageReader = null, record = () => {}, now = () => Date.now(), ttlMs = 10 * 60 * 1000, fetchImpl = globalThis.fetch, env = process.env, check = checkRefundTx, find = findCcdRefund } = {}) {
  let claims = new Map(); // payment tx -> { tx, url, payTo, payer, network, asset, amount, memo, reason, at }
  let refunds = new Map(); // payment tx -> { refundTx, matchedBy, amount, at, by }
  const recentClaims = [];
  const recentRefunds = [];
  const scannedAt = new Map(); // payment tx -> last time looked for on chain
  let loadedAt = 0;
  let pending = null;
  let scanning = null;

  const usedHashes = () => new Set([...refunds.values()].map((r) => r.refundTx));

  function refresh() {
    if (!usageReader || pending) return pending;
    pending = (async () => {
      const log = await usageReader.load({ days: DAYS, max: 200000 });
      const nextClaims = new Map();
      const nextRefunds = new Map();
      for (const e of log.events || []) {
        if (!e || !e.input) continue;
        if (e.route === 'outcome' && e.result?.accepted === true && e.input.refund && e.input.tx) {
          const c = claimOf(e.input, Date.parse(e.t || '') || null);
          if (c && !nextClaims.has(c.tx)) nextClaims.set(c.tx, c);
        } else if (e.route === 'refund' && e.result?.valid === true && e.input.tx && e.input.refund_tx) {
          if (!nextRefunds.has(e.input.tx)) nextRefunds.set(e.input.tx, { refundTx: e.input.refund_tx, matchedBy: e.result.matched_by || 'amount', amount: e.result.amount || null, at: e.result.at || Date.parse(e.t || '') || null, by: e.input.by || 'chain' });
        }
      }
      for (const c of recentClaims) if (!nextClaims.has(c.tx)) nextClaims.set(c.tx, c);
      for (const [tx, r] of recentRefunds) if (!nextRefunds.has(tx)) nextRefunds.set(tx, r);
      claims = nextClaims;
      refunds = nextRefunds;
      loadedAt = now();
    })().catch(() => {}).finally(() => { pending = null; });
    return pending;
  }
  const fresh = () => { if (now() - loadedAt > ttlMs) refresh(); };

  // One request as the outcome report recorded it (lib/outcomes.js: refund, refund_memo, pay_to, asset, amount).
  function claimOf(input, at) {
    if (!REFUND_REASONS.has(input.refund) || !String(input.refund_memo || '').startsWith(REFUND_PREFIX) || !ACCOUNT_RE.test(String(input.pay_to)) || !/^\d{1,30}$/.test(String(input.amount))) return null;
    const payer = String(input.payer || '').replace(/^ccd:/, '');
    return { tx: String(input.tx).toLowerCase(), url: input.url, payTo: input.pay_to, payer: ACCOUNT_RE.test(payer) ? payer : null, network: input.network, asset: String(input.asset), amount: String(input.amount), memo: input.refund_memo, reason: input.refund, at: at ?? now() };
  }

  // Called by lib/outcomes.js when it accepted a report that asks for a refund.
  function asked(input) {
    const c = claimOf(input, now());
    if (!c || claims.has(c.tx)) return null;
    claims.set(c.tx, c);
    recentClaims.push(c);
    return c;
  }

  function counted(tx, r) {
    refunds.set(tx, r);
    recentRefunds.push([tx, r]);
    record({ route: 'refund', via: 'refund', status: 200, paid: false, agent: 'none', input: { tx, refund_tx: r.refundTx, pay_to: claims.get(tx)?.payTo ?? null, by: r.by }, result: { valid: true, matched_by: r.matchedBy, amount: r.amount, at: r.at } });
  }

  // A refund sent by the seller or the wallet: { status, body }.
  async function prove(body, { by = 'sender' } = {}) {
    const b = body && typeof body === 'object' ? body : {};
    const receipt = b.receipt;
    const tx = String(b.tx ?? '').toLowerCase();
    const refundTx = String(b.refund_tx ?? '').toLowerCase();
    const problem = receiptProblem(receipt);
    if (problem) return { status: 400, body: { valid: false, reason: `receipt: ${problem}` } };
    if (refunds.has(tx)) return { status: 200, body: { valid: true, already: true, tx, refund: view(refunds.get(tx)) } };
    if (usedHashes().has(refundTx)) return { status: 400, body: { valid: false, reason: 'this transaction already refunds another purchase' } };
    const c = await check(receipt, tx, refundTx, { fetchImpl, env });
    if (!c.valid) return { status: c.notRead ? 503 : 400, body: { valid: false, reason: c.reason, ...(c.notRead ? { not_read: true } : {}), tx, refund_tx: refundTx } };
    const r = { refundTx, matchedBy: c.matchedBy, amount: c.amount, at: c.time ? Date.parse(c.time) || now() : now(), by };
    if (!claims.has(tx)) {
      // A refund nobody asked Doctor for still counts for the seller: the receipt and the chain say what it refunds.
      const claim = { tx, url: receipt.resource, payer: c.payer ?? null, ...termsOf(receipt), reason: null, at: r.at };
      claims.set(tx, claim);
    }
    counted(tx, r);
    return { status: 200, body: { valid: true, tx, refund: view(r), seller: ofSeller(receipt.payTo) } };
  }

  // Look on chain for open CCD requests (at most `max`, each at most once an hour). Background; never throws.
  function scan({ max = 10 } = {}) {
    if (scanning) return scanning;
    scanning = (async () => {
      const used = usedHashes();
      const open = [...claims.values()].filter((c) => !refunds.has(c.tx) && c.asset.toUpperCase() === 'CCD' && c.payer && now() - c.at < DAYS * 86400000 && now() - (scannedAt.get(c.tx) || 0) > SCAN_EVERY_MS)
        .sort((a, b) => (scannedAt.get(a.tx) || 0) - (scannedAt.get(b.tx) || 0)).slice(0, max);
      for (const c of open) await lookFor(c, used);
    })().catch(() => {}).finally(() => { scanning = null; });
    return scanning;
  }
  async function lookFor(c, used = usedHashes()) {
    scannedAt.set(c.tx, now());
    const f = await find(c, c.tx, c.payer, { fetchImpl, used }).catch(() => null);
    // one transaction refunds one purchase, whatever the lookup returns
    if (!f || f.notRead || refunds.has(c.tx) || used.has(f.refundTx) || usedHashes().has(f.refundTx)) return null;
    const r = { refundTx: f.refundTx, matchedBy: f.matchedBy, amount: f.amount, at: f.time || now(), by: 'chain' };
    used.add(f.refundTx);
    counted(c.tx, r);
    return r;
  }

  const hours = (c, r) => (c && r && r.at && c.at && c.reason ? Math.max(0, Math.round((r.at - c.at) / 36e5)) : null);
  const view = (r) => ({ refund_tx: r.refundTx, matched_by: r.matchedBy, amount: r.amount, at: r.at ? new Date(r.at).toISOString() : null, found_by: r.by });

  // One purchase: was a refund asked, and did it come? Looks on chain right away for an open CCD request not looked
  // for in the last 2 minutes (the wallet asks at most every 10).
  // A CCD payment no refund was asked for here: read it from the chain. Its memo x402r:<fingerprint> already names the
  // receipt, so the refund it would take is known (x402refund:<the same fingerprint>) without the receipt. Only a
  // transfer back with that memo counts: without a request, an amount alone proves nothing. Cached for ttlMs.
  const fromChainSeen = new Map();
  async function fromChain(key, network) {
    const net = NETWORKS[network];
    if (!net) return null;
    const hit = fromChainSeen.get(`${network}|${key}`);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const r = await readCcdTransaction(net, key, fetchImpl);
    if (r?.notRead) return { tx: key, network, asked: null, refunded: null, not_read: r.reason };
    const o = r?.outcome;
    const t = o?.success && Array.isArray(o.transfers) && o.transfers.length === 1 ? o.transfers[0] : null;
    const m = t && typeof t.memo === 'string' ? t.memo.match(/^x402r:([0-9a-f]{64})$/) : null;
    let value = null;
    if (m && ACCOUNT_RE.test(String(o.sender)) && ACCOUNT_RE.test(String(t.to))) {
      const terms = { network, asset: 'CCD', amount: t.amount, payTo: t.to, memo: `${REFUND_PREFIX}${m[1]}` };
      const f = await find(terms, key, o.sender, { fetchImpl, used: usedHashes() });
      if (f?.notRead) return { tx: key, network, asked: null, refunded: null, not_read: f.reason };
      value = {
        tx: key, url: null, pay_to: t.to, payer: o.sender, network, asset: 'CCD', amount: t.amount, asked: null, refund_memo: terms.memo,
        refunded: f && f.matchedBy === 'memo' ? { refund_tx: f.refundTx, matched_by: 'memo', amount: f.amount, at: f.time ? new Date(f.time).toISOString() : null, found_by: 'chain' } : null,
        from: 'chain',
      };
    }
    if (fromChainSeen.size > 500) fromChainSeen.clear();
    fromChainSeen.set(`${network}|${key}`, { at: now(), value });
    return value;
  }

  async function status(tx, { network = MAINNET } = {}) {
    fresh();
    if (scanning) await scanning;
    const key = String(tx || '').toLowerCase();
    const c = claims.get(key);
    if (!c) return /^[0-9a-f]{64}$/.test(key) ? fromChain(key, network) : null;
    if (!refunds.has(key) && c.asset.toUpperCase() === 'CCD' && now() - (scannedAt.get(key) || 0) > ASKED_EVERY_MS) await lookFor(c);
    const r = refunds.get(key);
    return {
      tx: key, url: c.url ?? null, pay_to: c.payTo, network: c.network, asset: c.asset, amount: c.amount,
      asked: c.reason ? { reason: c.reason, at: new Date(c.at).toISOString() } : null,
      refunded: r ? view(r) : null,
      ...(!r && c.reason ? { how_to_refund: howTo(c) } : {}),
    };
  }
  const howTo = (c) => `Send ${refundAmount(c.amount, c.asset)} from ${c.payTo} back to ${c.payer || 'the account that paid'} with the memo ${c.memo}; ${c.asset.toUpperCase() === 'CCD' ? 'Doctor finds a CCD refund on chain by itself within the hour' : 'then POST /api/v1/concordium/refund { receipt, tx, refund_tx }'}.`;

  // A seller's account over the last 30 days: { days, asked, refunded, open, refunded_unasked, median_hours } or null.
  function ofSeller(payTo) {
    fresh();
    if (claims.size) scan();
    const mine = [...claims.values()].filter((c) => c.payTo === payTo && now() - c.at < DAYS * 86400000);
    if (!mine.length) return null;
    const asked = mine.filter((c) => c.reason);
    const refunded = asked.filter((c) => refunds.has(c.tx));
    const took = refunded.map((c) => hours(c, refunds.get(c.tx))).filter((h) => h !== null).sort((a, b) => a - b);
    return {
      days: DAYS,
      asked: asked.length,
      refunded: refunded.length,
      open: asked.length - refunded.length,
      ...(mine.length > asked.length ? { refunded_unasked: mine.filter((c) => !c.reason && refunds.has(c.tx)).length } : {}),
      median_hours: took.length ? took[Math.floor((took.length - 1) / 2)] : null,
    };
  }

  // Hourly from the server: the log read again, then open CCD requests looked for on chain.
  async function tick() {
    await refresh();
    return scan();
  }

  return { asked, prove, status, ofSeller, scan, refresh, tick };
}

module.exports = { REFUND_PREFIX, REFUND_REASONS, refundMemo, refundAmount, termsOf, checkRefund, checkRefundTx, findCcdRefund, createRefunds };
