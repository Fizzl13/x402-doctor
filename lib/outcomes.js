// Outcome reports: Doctor learns from what happened after its preflights.
//
// After a paid preflight, a buyer (x402-safe-fetch with shareOutcomes, or any
// client) can report what happened when it then paid the endpoint:
//   paid_ok      the paid request answered 2xx
//   paid_failed  it answered 402 again: the payment was not accepted
//   paid_error   it answered another error after paying
// Doctor counts the reports per endpoint over the last 30 days. When most
// agents that paid an endpoint after a preflight saw the payment fail, later
// preflights for it say caution (payments_fail_after_preflight), so every
// buyer benefits from what the others ran into.
//
// Reports cannot be made up for free: each must carry the paid preflight it
// follows, signed by Doctor for exactly that endpoint (the receipt's input
// hash covers the query), and one preflight counts once (receipt request_id).
// So a false report costs a real $0.001 preflight, and one wallet cannot flip
// an endpoint on its own: the caution needs failed payments reported by at
// least MIN_REPORTS different paying wallets (the receipt names the payer).
// Nothing about the buyer is stored beyond the usage log's usual fields.

'use strict';

const { verifyReceipt } = require('./receipt');

const OUTCOMES = new Set(['paid_ok', 'paid_failed', 'paid_error']);
const PREFLIGHT_ROUTE = 'GET /api/v1/preflight';
const MIN_REPORTS = 3;
const FAIL_SHARE = 0.5;
const DAYS = 30;

// The report as sent, checked for shape; { error } when it is not usable.
function parseReport(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!OUTCOMES.has(b.outcome)) return { error: `outcome must be one of ${[...OUTCOMES].join(', ')}` };
  const pf = b.preflight;
  if (!pf || typeof pf !== 'object' || !pf.receipt || typeof pf.receipt !== 'object') return { error: 'preflight must be the signed preflight answer this outcome follows' };
  const query = b.query;
  if (!query || typeof query !== 'object' || typeof query.url !== 'string') return { error: 'query must be the preflight query parameters (url, method, max_usd, network) as strings' };
  if (!['go', 'caution'].includes(pf.verdict)) return { error: 'only a go or caution preflight is followed by a payment' };
  const status = b.status === undefined || b.status === null ? null : Number(b.status);
  if (status !== null && !(Number.isInteger(status) && status >= 100 && status <= 599)) return { error: 'status must be an HTTP status code' };
  let url;
  try {
    url = new URL(query.url).href;
  } catch {
    return { error: 'query.url is not a valid URL' };
  }
  return { url, outcome: b.outcome, status, query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])), preflight: pf, requestId: String(pf.receipt.request_id || '') };
}

function createOutcomes({ usageReader, record = () => {}, signers = () => [], authority, now = () => Date.now(), ttlMs = 10 * 60 * 1000 } = {}) {
  let counts = new Map(); // url -> { reports, failed }
  let seen = new Set(); // request ids already counted
  const recent = []; // reports accepted by this process: { id, url, outcome, at }
  let loadedAt = 0;
  let pending = null;

  function add(map, url, outcome, payer) {
    const c = map.get(url) || { reports: 0, failed: 0, failedPayers: new Set() };
    c.reports++;
    if (outcome !== 'paid_ok') {
      c.failed++;
      c.failedPayers.add(String(payer || 'unknown').toLowerCase());
    }
    map.set(url, c);
  }
  const view = (c) => ({ reports: c.reports, failed: c.failed, failed_payers: c.failedPayers.size });

  // Rebuild the counts from the usage log (accepted reports of the last 30
  // days), plus the reports this process accepted that the log has not caught
  // up with yet.
  function refresh() {
    if (!usageReader || pending) return pending;
    pending = (async () => {
      const log = await usageReader.load({ days: DAYS, max: 200000 });
      const next = new Map();
      const ids = new Set();
      for (const e of log.events || []) {
        if (!e || e.route !== 'outcome' || !e.result || e.result.accepted !== true) continue;
        const id = e.input && e.input.request_id;
        if (!id || ids.has(id)) continue;
        ids.add(id);
        add(next, e.input.url, e.input.outcome, e.input.payer);
      }
      for (let i = recent.length - 1; i >= 0; i--) {
        const r = recent[i];
        if (ids.has(r.id) || now() - r.at > DAYS * 86400000) {
          recent.splice(i, 1);
          continue;
        }
        ids.add(r.id);
        add(next, r.url, r.outcome, r.payer);
      }
      counts = next;
      seen = ids;
      loadedAt = now();
    })().catch(() => {}).finally(() => { pending = null; });
    return pending;
  }

  // What agents reported for this endpoint (sync; refreshes in the background).
  function lookup(url) {
    if (now() - loadedAt > ttlMs) refresh();
    let key;
    try { key = new URL(url).href; } catch { return null; }
    const c = counts.get(key);
    return c ? view(c) : null;
  }

  // Check and count one report. Returns { status, body } for the HTTP answer.
  async function report(body, { agent = 'none', visitor } = {}) {
    const r = parseReport(body);
    if (r.error) return { status: 400, body: { accepted: false, error: r.error } };
    const check = await verifyReceipt(r.preflight, { signers: signers(), route: PREFLIGHT_ROUTE, input: r.query, authority });
    if (!check.valid || check.known_signer !== true) {
      return { status: 400, body: { accepted: false, error: `the preflight is not a valid Doctor answer for this query (${check.reason || 'unknown signer'})` } };
    }
    let preflightUrl = null;
    try { preflightUrl = new URL(r.preflight.url).href; } catch { /* checked below */ }
    if (preflightUrl !== r.url) return { status: 400, body: { accepted: false, error: 'the preflight is for another endpoint' } };
    if (!r.requestId) return { status: 400, body: { accepted: false, error: 'the preflight receipt has no request_id' } };
    if (seen.has(r.requestId)) return { status: 200, body: { accepted: false, duplicate: true } };
    seen.add(r.requestId);
    const payer = (r.preflight.receipt.payment && r.preflight.receipt.payment.payer) || null;
    recent.push({ id: r.requestId, url: r.url, outcome: r.outcome, payer, at: now() });
    add(counts, r.url, r.outcome, payer);
    record({
      route: 'outcome',
      via: 'feedback',
      status: 200,
      paid: false,
      agent,
      ...(visitor ? { visitor } : {}),
      input: { url: r.url, outcome: r.outcome, status: r.status, verdict: r.preflight.verdict, request_id: r.requestId, payer },
      result: { accepted: true },
    });
    return { status: 200, body: { accepted: true, endpoint: { url: r.url, ...view(counts.get(r.url)) } } };
  }

  return { report, lookup, refresh };
}

// The preflight reason when agents' payments to this endpoint mostly failed.
function outcomeReason(learned) {
  if (!learned || learned.failed_payers < MIN_REPORTS || learned.failed / learned.reports < FAIL_SHARE) return null;
  return {
    level: 'caution',
    code: 'payments_fail_after_preflight',
    message: `${learned.failed} of ${learned.reports} payments that agents reported after a Doctor preflight in the last ${DAYS} days failed (${learned.failed_payers} different wallets).`,
  };
}

module.exports = { createOutcomes, parseReport, outcomeReason, OUTCOMES, MIN_REPORTS, FAIL_SHARE };
