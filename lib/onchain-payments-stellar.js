// Real payments on Stellar: how many USDC payments, from how many different wallets, reached each Stellar payout
// address in the Trust Index. x402's exact scheme settles on Stellar with a Soroban call to the USDC contract
// (transfer(from, to, amount)): the buyer only signs an authorization for that transfer, and the facilitator sends
// the transaction from its own account (OpenZeppelin's channels: a channel account, wrapped in a fee bump). So a
// payment counts when Circle's USDC moved to the payout address in a Soroban call sent by another account than the
// payer; a plain payment (the sender sends its own transaction, classic or Soroban) doesn't. Collected every hour by
// scripts/onchain-payments.js into payments-stellar.json (payments-data branch), in the same shape as Base's
// payments.json, so lib/onchain-payments.js reads it too. Read-only: it never pays and holds no key.
//
// Horizon lists every operation an account takes part in, Soroban token transfers included (asset_balance_changes),
// so each payout address's operations since the last one read are asked, oldest first. Addresses not reached in a
// run (rate limits, the time budget) are picked up by the next one: nothing is lost, it is only later.

const { isStellarAddress, NETWORKS } = require('./networks');

const STELLAR = 'stellar:pubnet';
const USDC_ISSUER = NETWORKS[STELLAR].usdcIssuer;
const USDC_CONTRACT = NETWORKS[STELLAR].usdc;
const PUBLIC_HORIZON = NETWORKS[STELLAR].horizon;
const KEEP_DAYS = 8; // today and the 7 days before it, as on Base
const MAX_PAYERS = 5000;
const MAX_RECIPIENTS = 300;
const PAGE = 200; // operations per Horizon page (its maximum)
const MAX_PAGES = 5; // per payout address per run; a busier one continues next run

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefix = (a) => String(a).slice(0, 10); // tells wallets apart without listing them, as on Base
// Horizon keeps operations per account (G…); a contract (C…) or muxed (M…) payTo can't be asked this way.
const watchable = (a) => isStellarAddress(a, 'G');

// The Stellar payout addresses (USDC offers) the daily scan saw, kept for 14 days, with the hosts of the Trust Index
// endpoints that pay to them (at most 3), for the public list of who gets paid.
function mergeStellarPayTos(previous, results, date, keepDays = 14) {
  const payTos = { ...(previous?.pay_tos || {}) };
  const seenHosts = {};
  for (const r of results) {
    let host = null;
    try { host = new URL(r?.url).hostname; } catch { /* no URL */ }
    for (const a of r?.stellar_pay_tos || []) {
      if (!watchable(a)) continue;
      payTos[a] = date;
      const list = seenHosts[a] || (seenHosts[a] = []);
      if (host && !list.includes(host) && list.length < 3) list.push(host);
    }
  }
  const hosts = { ...(previous?.hosts || {}), ...Object.fromEntries(Object.entries(seenHosts).filter(([, list]) => list.length)) };
  const cutoff = dayOf(Date.parse(`${date}T00:00:00Z`) - keepDays * 86400000);
  for (const [a, last] of Object.entries(payTos)) if (last < cutoff) delete payTos[a];
  for (const a of Object.keys(hosts)) if (!payTos[a]) delete hosts[a];
  return { network: STELLAR, updated: date, pay_tos: payTos, ...(Object.keys(hosts).length ? { hosts } : {}) };
}

// Horizon with a pace and patience. The public Horizon allows 3,600 requests an hour per IP; a 429 is waited out for
// the seconds its Retry-After names (up to maxWaitMs), unless that would end after `deadline` (the run's budget). A
// node that keeps failing hands over to the next. An account Horizon doesn't know (404: never funded) answers null.
const BUSY = /429|rate limit|too many/i;
function createHorizon(nodes, { fetchImpl = fetch, minGapMs = 250, retries = 3, maxWaitMs = 60_000, deadline = Infinity, wait = sleep } = {}) {
  let lastAt = 0;
  return async function get(path) {
    let last;
    for (const base of nodes) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const gap = lastAt + minGapMs - Date.now();
        if (gap > 0) await wait(gap);
        lastAt = Date.now();
        let res = null;
        try {
          res = await fetchImpl(`${base.replace(/\/$/, '')}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
          if (res.status === 404) return null;
          if (res.ok) return await res.json();
          last = new Error(`horizon HTTP ${res.status}`);
        } catch (err) {
          last = err;
        }
        if (res && res.status !== 429 && res.status < 500) break; // not busy: next node
        const asked = (Number(res?.headers?.get?.('retry-after')) || 0) * 1000;
        const pause = Math.max(1000 * 2 ** attempt, Math.min(asked, maxWaitMs));
        if (Date.now() + pause > deadline) throw last;
        await wait(pause);
      }
    }
    throw last;
  };
}

const emptyState = () => ({ version: 1, network: STELLAR, token: USDC_CONTRACT, per_day: 1, updated: null, cursor: 0, days: {}, pay_tos: {} });

const isUsdc = (c) => c?.asset_code === 'USDC' && c?.asset_issuer === USDC_ISSUER;
const microOf = (amount) => Math.round(Number(amount) * 1e6); // Horizon gives amounts with 7 decimals: "0.0100000"

// The USDC that moved in one operation (joined with its transaction) as seen from a payout address: payments into it
// (x402 when a Soroban transfer was sent by another account than the payer) and out of it, in micro-dollars.
function paymentsOf(op, payTo) {
  if (!op || op.transaction_successful === false) return [];
  const out = [];
  if (op.type === 'invoke_host_function') {
    const sender = op.transaction?.source_account || op.source_account;
    for (const c of op.asset_balance_changes || []) {
      if (c.type !== 'transfer' || !isUsdc(c)) continue;
      const micro = microOf(c.amount);
      if (!Number.isFinite(micro) || micro <= 0) continue;
      if (c.to === payTo && c.from !== payTo) out.push({ dir: 'in', x402: Boolean(sender) && sender !== c.from, from: c.from, micro });
      else if (c.from === payTo && c.to !== payTo) out.push({ dir: 'out', to: c.to, micro });
    }
    return out;
  }
  // Classic payments: never an x402 payment in, but money sent out counts for the closed-loop check.
  if (['payment', 'path_payment_strict_send', 'path_payment_strict_receive'].includes(op.type) && isUsdc(op)) {
    const micro = microOf(op.amount);
    if (!Number.isFinite(micro) || micro <= 0) return [];
    if (op.to === payTo && op.from !== payTo) out.push({ dir: 'in', x402: false, from: op.from, micro });
    else if (op.from === payTo && op.to !== payTo) out.push({ dir: 'out', to: op.to, micro });
  }
  return out;
}

// Reads what is new on the watched payout addresses and adds each x402 USDC payment to its day (and USDC sent out of
// them, per recipient, for the closed-loop check). Stops at the time budget; the next run goes on where this one
// stopped.
async function collectStellar(state, { payTos, nodes = [PUBLIC_HORIZON], fetchImpl = fetch, now = Date.now, budgetMs = 10 * 60 * 1000, minGapMs, wait, log = () => {} } = {}) {
  const s = state?.version === 1 && state.network === STELLAR ? JSON.parse(JSON.stringify(state)) : emptyState();
  const started = now();
  const today = dayOf(started);
  const get = createHorizon(nodes, { fetchImpl, deadline: Date.now() + budgetMs, ...(minGapMs !== undefined ? { minGapMs } : {}), ...(wait ? { wait } : {}) });
  const watch = [...new Set((payTos || []).filter(watchable))];
  for (const a of watch) if (!s.pay_tos[a]) s.pay_tos[a] = { since: today, d: {}, last: null };
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
      const first = !entry.last;
      // First sight: newest first, today's only; after that: oldest first, everything since the last one read.
      let fresh = [], cursor = first ? null : entry.last, newest = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await get(`/accounts/${payTo}/operations?order=${first ? 'desc' : 'asc'}&limit=${PAGE}&join=transactions${cursor ? `&cursor=${cursor}` : ''}`);
        const list = body?._embedded?.records || [];
        if (first && page === 0 && list[0]) newest = list[0].paging_token;
        const usable = first ? list.filter((op) => Date.parse(op.created_at) >= floor) : list;
        fresh.push(...usable);
        if (list.length < PAGE || usable.length < list.length) break;
        cursor = list.at(-1).paging_token;
      }
      if (first) fresh.reverse();
      for (const op of fresh) {
        const day = dayOf(Number.isFinite(Date.parse(op.created_at)) ? Date.parse(op.created_at) : started);
        for (const p of paymentsOf(op, payTo)) {
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
      }
      // Remember where to go on: the last operation read, or on first sight the newest one there is.
      const lastRead = first ? newest : fresh.at(-1)?.paging_token;
      if (lastRead) entry.last = lastRead;
      reached++;
    } catch (err) {
      log(`${payTo}: ${err.message}`);
      if (BUSY.test(err.message)) { stoppedAt = i; break; }
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
  log(`${added} x402 payments and ${sent} outgoing transfers added (${plain} payments sent by the payer itself left out); ${reached} of ${watch.length} payout addresses read${s.backlog ? `, ${s.backlog} left for the next run` : ''}`);
  return s;
}

module.exports = { STELLAR, USDC_ISSUER, USDC_CONTRACT, PUBLIC_HORIZON, mergeStellarPayTos, collectStellar, paymentsOf, createHorizon };
