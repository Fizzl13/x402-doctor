// Real payments on the XRP Ledger: how many x402 payments in dollar stablecoins (RLUSD, USDC), from how many different
// wallets, reached each XRPL payout address in the Trust Index. On the XRP Ledger the buyer signs a complete Payment
// and pays its own (tiny) fee; the facilitator only submits it, so no fee payer tells an x402 payment from a plain
// one. x402 clients mark the payment instead: t54's SDK signs with SourceTag 804681468, and @x402/xrpl binds the
// invoice in InvoiceID. A payment counts when it carries one of the two; a plain payment doesn't. Payments in XRP are
// left out (no dollar amount without a price). x402's batch-settlement scheme settles on XRPL with a Check (t54's
// "xrpl-check-session"): the buyer creates one to the seller, marked the same way, and the seller cashes it later
// for the calls made, one CheckCash for many calls. Each cashed Check counts as one payment, from the buyer who
// created it (October 2026: the XRPL AI Hub's busiest merchant settles all its calls this way). Collected every hour by scripts/onchain-payments.js into
// payments-xrpl.json (payments-data branch), in the same shape as Base's payments.json, so lib/onchain-payments.js
// reads it too. Read-only: it never pays and holds no key.
//
// Each payout address's transactions since the last ledger read are asked with account_tx, oldest first. Addresses
// not reached in a run (rate limits, the time budget) are picked up by the next one: nothing is lost, it is only later.

const { isXrplAddress, NETWORKS } = require('./networks');

const XRPL = 'xrpl:0';
const X402_SOURCE_TAG = 804681468;
// The dollar stablecoins counted: Ripple's RLUSD and Circle's USDC, each by its issuer (anyone can issue a token
// with the same currency code).
const DOLLARS = [
  { symbol: 'RLUSD', currency: NETWORKS[XRPL].rlusd.currency, issuer: NETWORKS[XRPL].rlusd.issuer },
  { symbol: 'USDC', currency: '5553444300000000000000000000000000000000', issuer: 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE' },
];
const SYMBOL = 'RLUSD or USDC';
const PUBLIC_NODES = ['https://xrplcluster.com/', 'https://xrpl.ws/'];
const RIPPLE_EPOCH = 946684800; // XRPL times are seconds since 2000-01-01
const KEEP_DAYS = 8; // today and the 7 days before it, as on Base
const MAX_PAYERS = 5000;
const MAX_RECIPIENTS = 300;
const PAGE = 200; // transactions per account_tx call
const MAX_PAGES = 5; // per payout address per run; a busier one continues next run

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefix = (a) => String(a).slice(0, 10); // tells wallets apart without listing them, as on Base
const watchable = (a) => isXrplAddress(a);

// The XRPL payout addresses the daily scan saw, kept for 14 days.
function mergeXrplPayTos(previous, results, date, keepDays = 14) {
  const payTos = { ...(previous?.pay_tos || {}) };
  for (const r of results) for (const a of r?.xrpl_pay_tos || []) if (watchable(a)) payTos[a] = date;
  const cutoff = dayOf(Date.parse(`${date}T00:00:00Z`) - keepDays * 86400000);
  for (const [a, last] of Object.entries(payTos)) if (last < cutoff) delete payTos[a];
  return { network: XRPL, updated: date, pay_tos: payTos };
}

// rippled's JSON-RPC with a pace and patience. A busy node (429, slowDown, tooBusy) is asked again after a pause; a
// node that can't answer hands over to the next. An answer about the account itself (not found, malformed) is the
// same on every node and is thrown at once.
const BUSY = /slowDown|tooBusy|429/;
const ACCOUNT_ERRORS = new Set(['actNotFound', 'actMalformed']);
function createXrplRpc(nodes, { fetchImpl = fetch, minGapMs = 250, retries = 3, wait = sleep } = {}) {
  let lastAt = 0;
  return async function rpc(method, params) {
    let last;
    for (const url of nodes) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const gap = lastAt + minGapMs - Date.now();
        if (gap > 0) await wait(gap);
        lastAt = Date.now();
        let busy = false;
        try {
          const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(30000) });
          const body = await res.json().catch(() => null);
          const r = body?.result;
          if (r && r.status === 'success') return r;
          last = Object.assign(new Error(r?.error_message || r?.error || `HTTP ${res.status}`), { code: r?.error || null });
          if (ACCOUNT_ERRORS.has(r?.error)) throw last;
          busy = res.status === 429 || res.status === 503 || BUSY.test(r?.error || '');
        } catch (err) {
          if (ACCOUNT_ERRORS.has(err.code)) throw err;
          last = err;
        }
        if (!busy) break; // not a rate limit: next node
        await wait(1000 * 2 ** attempt);
      }
    }
    throw last;
  };
}

const emptyState = () => ({ version: 1, network: XRPL, symbol: SYMBOL, tokens: DOLLARS.map((d) => `${d.symbol}.${d.issuer}`), per_day: 1, updated: null, cursor: 0, days: {}, pay_tos: {} });

const txOf = (t) => t?.tx || t?.tx_json || null;
const ledgerOf = (t) => Number(txOf(t)?.ledger_index ?? t?.ledger_index ?? 0);
const msOf = (t) => {
  const date = txOf(t)?.date;
  if (Number.isFinite(date)) return (date + RIPPLE_EPOCH) * 1000;
  return t?.close_time_iso ? Date.parse(t.close_time_iso) : NaN;
};

// The Check a CheckCash cashed (its last fields, from the ledger entry the CheckCash deleted), or null.
function cashedCheck(meta) {
  for (const n of meta?.AffectedNodes || []) {
    const d = n.DeletedNode;
    if (d?.LedgerEntryType === 'Check') return d.FinalFields || null;
  }
  return null;
}
const marked = (o) => o?.SourceTag === X402_SOURCE_TAG || /^[0-9A-F]{64}$/i.test(o?.InvoiceID || '');

// One transaction seen from a payout address: a dollar-stablecoin payment into it (with whether an x402 client marked
// it) or out of it, in micro-dollars, or null for anything else (failed, XRP, another token, not a payment). A
// Payment, or a cashed Check (the money moves from the Check's creator to the account that cashes it).
function paymentOf(t, payTo) {
  const tx = txOf(t), meta = t?.meta || t?.metaData;
  if (!tx || !['Payment', 'CheckCash'].includes(tx.TransactionType) || meta?.TransactionResult !== 'tesSUCCESS') return null;
  // What actually arrived: delivered_amount (a partial payment can deliver less than Amount says).
  const amt = meta.delivered_amount ?? meta.DeliveredAmount;
  if (!amt || typeof amt !== 'object') return null;
  if (!DOLLARS.some((d) => d.currency === amt.currency && d.issuer === amt.issuer)) return null;
  const micro = Math.round(Number(amt.value) * 1e6);
  if (!Number.isFinite(micro) || micro <= 0) return null;
  if (tx.TransactionType === 'CheckCash') {
    const check = cashedCheck(meta);
    if (!check?.Account || check.Account === tx.Account) return null;
    if (tx.Account === payTo) return { dir: 'in', x402: marked(tx) || marked(check), from: check.Account, micro };
    if (check.Account === payTo) return { dir: 'out', to: tx.Account, micro };
    return null;
  }
  if (tx.Destination === payTo && tx.Account !== payTo) return { dir: 'in', x402: marked(tx), from: tx.Account, micro };
  if (tx.Account === payTo && tx.Destination !== payTo) return { dir: 'out', to: tx.Destination, micro };
  return null;
}

// Reads what is new on the watched payout addresses and adds each x402 payment in RLUSD or USDC to its day (and what
// was sent out of them, per recipient, for the closed-loop check). Stops at the time budget; the next run goes on
// where this one stopped.
async function collectXrpl(state, { payTos, nodes = PUBLIC_NODES, fetchImpl = fetch, now = Date.now, budgetMs = 5 * 60 * 1000, minGapMs, wait, log = () => {} } = {}) {
  const s = state?.version === 1 && state.network === XRPL ? JSON.parse(JSON.stringify(state)) : emptyState();
  const started = now();
  const today = dayOf(started);
  const rpc = createXrplRpc(nodes, { fetchImpl, ...(minGapMs !== undefined ? { minGapMs } : {}), ...(wait ? { wait } : {}) });
  const watch = [...new Set((payTos || []).filter(watchable))];
  for (const a of watch) if (!s.pay_tos[a]) s.pay_tos[a] = { since: today, d: {}, ledger: null };
  const watched = new Set(watch);
  // On first sight an address is read from the start of today (at most MAX_PAGES pages back), not its whole history.
  const floor = Date.parse(`${today}T00:00:00Z`);

  let added = 0, plain = 0, sent = 0, reached = 0;
  const order = watch.length ? [...watch.slice(s.cursor % watch.length), ...watch.slice(0, s.cursor % watch.length)] : [];
  let stoppedAt = null;
  for (const [i, payTo] of order.entries()) {
    if (now() - started > budgetMs) { stoppedAt = i; break; }
    const entry = s.pay_tos[payTo];
    try {
      const first = entry.ledger === null;
      // The newest validated ledger at the first call bounds every page, so a ledger closing in between isn't read
      // twice (once now, once next run).
      let top = null, marker, more = false;
      let fresh = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await rpc('account_tx', {
          account: payTo, limit: PAGE, forward: !first,
          ledger_index_min: first ? -1 : entry.ledger + 1, ledger_index_max: top ?? -1,
          ...(marker ? { marker } : {}),
        });
        if (top === null) top = Number(r.ledger_index_max);
        const list = r.transactions || [];
        // First sight: newest first, today's only; after that: oldest first, everything since the last ledger read.
        const usable = first ? list.filter((t) => msOf(t) >= floor) : list;
        fresh.push(...usable);
        more = Boolean(r.marker) && usable.length === list.length;
        if (!more) break;
        marker = r.marker;
      }
      if (first) fresh.reverse();
      // Cut short in the middle: keep the last ledger read for the next run, so its transactions are read whole.
      let upTo = top;
      if (more && !first && fresh.length) {
        const lastLedger = ledgerOf(fresh.at(-1));
        const before = fresh.filter((t) => ledgerOf(t) < lastLedger);
        if (before.length) { fresh = before; upTo = lastLedger - 1; }
      }
      for (const t of fresh) {
        const p = paymentOf(t, payTo);
        if (!p) continue;
        const day = dayOf(Number.isFinite(msOf(t)) ? msOf(t) : started);
        if (p.dir === 'in') {
          if (!p.x402) { plain++; continue; }
          const d = (entry.d[day] ||= [0, 0, []]);
          d[0] += 1;
          d[1] += p.micro;
          const who = prefix(p.from);
          if (!d[2].includes(who) && d[2].length < MAX_PAYERS) d[2].push(who);
          added++;
        } else {
          const d = (entry.d[day] ||= [0, 0, []]);
          const out = (d[3] ||= {});
          const to = prefix(p.to);
          if (to in out || Object.keys(out).length < MAX_RECIPIENTS) out[to] = (out[to] || 0) + p.micro;
          sent++;
        }
      }
      if (Number.isFinite(upTo) && upTo > (entry.ledger ?? -1)) entry.ledger = upTo;
      reached++;
    } catch (err) {
      // An account that doesn't exist yet (never funded) has nothing to count; it is asked again next run.
      if (err.code === 'actNotFound') { reached++; continue; }
      log(`${payTo}: ${err.message}`);
      if (BUSY.test(err.code || err.message)) { stoppedAt = i; break; }
    }
  }
  s.cursor = watch.length ? (s.cursor + (stoppedAt === null ? 0 : stoppedAt)) % watch.length : 0;
  s.days[today] = { covered: 1 };

  const cutoff = dayOf(Date.parse(`${today}T00:00:00Z`) - (KEEP_DAYS - 1) * 86400000);
  for (const day of Object.keys(s.days)) if (day < cutoff) delete s.days[day];
  for (const [a, entry] of Object.entries(s.pay_tos)) {
    for (const day of Object.keys(entry.d)) if (day < cutoff) delete entry.d[day];
    if (!watched.has(a) && !Object.keys(entry.d).length) delete s.pay_tos[a];
  }
  s.backlog = stoppedAt === null ? 0 : order.length - stoppedAt;
  s.updated = new Date(now()).toISOString();
  log(`${added} x402 payments and ${sent} outgoing payments added (${plain} unmarked payments in left out); ${reached} of ${watch.length} payout addresses read${s.backlog ? `, ${s.backlog} left for the next run` : ''}`);
  return s;
}

module.exports = { XRPL, X402_SOURCE_TAG, DOLLARS, SYMBOL, PUBLIC_NODES, mergeXrplPayTos, collectXrpl, paymentOf, createXrplRpc };
