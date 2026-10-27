// Real payments on Algorand: how many USDC payments, from how many different wallets, reached each Algorand payout
// address. x402's exact scheme settles on Algorand with an atomic group: the buyer signs a USDC transfer (an asset
// transfer of ASA 31566704) with a fee of 0, and the facilitator adds a transaction of its own to the group that pays
// the fees of both (fee pooling; GoPlausible's facilitator). So a payment counts when USDC reached the payout address
// in a grouped transfer whose own fee was 0: someone else in the group paid for it. A plain transfer (the sender pays
// its own fee) doesn't. Collected every hour by scripts/onchain-payments.js into payments-algorand.json
// (payments-data branch), in the same shape as Base's payments.json, so lib/onchain-payments.js reads it too.
// Read-only: it never pays and holds no key.
//
// The payout addresses come from two places: the daily Trust Index scan (paytos-algorand.json: endpoints a registry
// lists), and the fee payers of the facilitators that settle x402 on Algorand (FACILITATORS). Every address that
// received USDC in a group such a fee payer paid for is watched too, as on Stellar.
//
// The indexer lists an address's transactions newest first; each run asks for the USDC transfers since the last round
// read (min-round). Addresses not reached in a run (rate limits, the time budget) are picked up by the next one:
// nothing is lost, it is only later.

const { isAlgorandAddress, NETWORKS } = require('./networks');

const ALGORAND = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const USDC_ASA = Number(NETWORKS[ALGORAND].usdc);
const PUBLIC_INDEXER = 'https://mainnet-idx.algonode.cloud';
// The fee payers of the facilitators that settle x402 payments on Algorand (their /supported extra.feePayer), and
// whose they are.
const FACILITATORS = {
  ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA: 'GoPlausible',
};
const KEEP_DAYS = 8; // today and the 7 days before it, as on Base
const MAX_PAYERS = 5000;
const MAX_RECIPIENTS = 300;
const PAGE = 1000; // transactions per indexer page (its maximum)
const MAX_PAGES = 5; // per payout address per run
const FOUND_KEEP_DAYS = 14; // an address found through a facilitator stays watched this long after its last payment
const MAX_FEE_TX = 400; // fee payer transactions (groups) opened per facilitator per run, newest first

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefix = (a) => String(a).slice(0, 10); // tells wallets apart without listing them, as on Base
const watchable = (a) => isAlgorandAddress(a);
// The network of an option on Algorand mainnet (the full genesis hash or its 32-character form), with USDC.
const isAlgorandUsdc = (network, asset) => NETWORKS[network]?.family === 'algorand' && !NETWORKS[network].testnet && String(asset) === String(USDC_ASA);

// The Algorand payout addresses (USDC offers) the daily scan saw, kept for 14 days, with the hosts of the Trust Index
// endpoints that pay to them (at most 3), for the public list of who gets paid.
function mergeAlgorandPayTos(previous, results, date, keepDays = 14) {
  const payTos = { ...(previous?.pay_tos || {}) };
  const seenHosts = {};
  for (const r of results) {
    let host = null;
    try { host = new URL(r?.url).hostname; } catch { /* no URL */ }
    for (const a of r?.algorand_pay_tos || []) {
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
  return { network: ALGORAND, updated: date, pay_tos: payTos, ...(Object.keys(hosts).length ? { hosts } : {}) };
}

// The indexer with a pace and patience: a 429 or 5xx is waited out (Retry-After, up to maxWaitMs) unless that would
// end after `deadline` (the run's budget); a node that keeps failing hands over to the next. Unknown: null.
const BUSY = /429|rate limit|too many/i;
function createIndexer(nodes, { fetchImpl = fetch, minGapMs = 100, retries = 3, maxWaitMs = 60_000, deadline = Infinity, wait = sleep } = {}) {
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
          last = new Error(`indexer HTTP ${res.status}`);
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

const emptyState = () => ({ version: 1, network: ALGORAND, token: String(USDC_ASA), per_day: 1, updated: null, cursor: 0, days: {}, pay_tos: {} });

// The USDC that moved in one transaction as seen from a payout address: payments into it (x402 when the transfer is
// grouped and its own fee was 0, so another transaction in the group paid it) and out of it, in micro-dollars (USDC
// has 6 decimals on Algorand).
function paymentsOf(tx, payTo) {
  const a = tx?.['asset-transfer-transaction'];
  if (!a || tx['tx-type'] !== 'axfer' || Number(a['asset-id']) !== USDC_ASA) return [];
  const micro = Number(a.amount);
  if (!Number.isFinite(micro) || micro <= 0) return [];
  if (a.receiver === payTo && tx.sender !== payTo) return [{ dir: 'in', x402: Number(tx.fee) === 0 && Boolean(tx.group), from: tx.sender, micro }];
  if (tx.sender === payTo && a.receiver && a.receiver !== payTo) return [{ dir: 'out', to: a.receiver, micro }];
  return [];
}

// Every transaction of an address since a round (newest first, as the indexer gives them), at most MAX_PAGES pages,
// and the indexer's current round when the list was read to the end.
async function transactionsOf(get, address, query) {
  const out = [];
  let next = null, current = null, complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await get(`/v2/accounts/${address}/transactions?limit=${PAGE}&${query}${next ? `&next=${encodeURIComponent(next)}` : ''}`);
    if (!body) { complete = true; break; }
    current ??= body['current-round'] ?? null;
    out.push(...(body.transactions || []));
    next = body['next-token'];
    if (!next || !(body.transactions || []).length) { complete = true; break; }
  }
  return { list: out, current, complete };
}

// Reads what is new at the facilitators' fee payers and records every address that received USDC in a group they paid
// for, in a transfer with a fee of 0 (state.found: address → { via, first, seen }, kept FOUND_KEEP_DAYS after the
// last one). On first sight a fee payer is read FOUND_KEEP_DAYS back; each run opens at most MAX_FEE_TX groups, the
// newest first.
async function discoverAlgorand(s, { get, facilitators, today, log }) {
  s.facilitators ||= {};
  s.found ||= {};
  let found = 0, opened = 0;
  for (const [fee, via] of Object.entries(facilitators)) {
    const st = (s.facilitators[fee] ||= { round: null });
    try {
      const since = st.round ? `min-round=${st.round + 1}` : `after-time=${dayOf(Date.parse(`${today}T00:00:00Z`) - FOUND_KEEP_DAYS * 86400000)}T00:00:00Z`;
      const { list, current } = await transactionsOf(get, fee, since);
      const groups = [...new Map(list.filter((t) => t.group && t.sender === fee).map((t) => [t.group, t])).values()].slice(0, MAX_FEE_TX);
      for (const t of groups) {
        const members = (await get(`/v2/transactions?group-id=${encodeURIComponent(t.group)}`))?.transactions || [];
        const day = dayOf(Number(t['round-time']) * 1000);
        for (const m of members) {
          const a = m['asset-transfer-transaction'];
          if (m['tx-type'] !== 'axfer' || Number(a?.['asset-id']) !== USDC_ASA || Number(m.fee) !== 0 || !(Number(a.amount) > 0)) continue;
          if (!watchable(a.receiver) || a.receiver === m.sender || a.receiver === fee) continue;
          if (!s.found[a.receiver]) { s.found[a.receiver] = { via, first: day, seen: day }; found++; }
          else if (day > s.found[a.receiver].seen) s.found[a.receiver].seen = day;
        }
        opened++;
      }
      // Go on from the newest round there is: groups beyond MAX_FEE_TX in a busy hour are skipped, not read late.
      const newest = Math.max(current ?? 0, ...list.map((t) => Number(t['confirmed-round']) || 0));
      if (newest) st.round = newest;
    } catch (err) {
      log(`facilitator ${via}: ${err.message}`);
    }
  }
  const cutoff = dayOf(Date.parse(`${today}T00:00:00Z`) - FOUND_KEEP_DAYS * 86400000);
  for (const [a, f] of Object.entries(s.found)) if (f.seen < cutoff) delete s.found[a];
  log(`${opened} facilitator groups read, ${found} new payout addresses found (${Object.keys(s.found).length} in all)`);
}

// Reads what is new on the watched payout addresses and adds each x402 USDC payment to its day (and USDC sent out of
// them, per recipient, for the closed-loop check). Stops at the time budget; the next run goes on where this one
// stopped.
async function collectAlgorand(state, { payTos, facilitators = FACILITATORS, nodes = [PUBLIC_INDEXER], fetchImpl = fetch, now = Date.now, budgetMs = 10 * 60 * 1000, minGapMs, wait, log = () => {} } = {}) {
  const s = state?.version === 1 && state.network === ALGORAND ? JSON.parse(JSON.stringify(state)) : emptyState();
  const started = now();
  const today = dayOf(started);
  const get = createIndexer(nodes, { fetchImpl, deadline: Date.now() + budgetMs, ...(minGapMs !== undefined ? { minGapMs } : {}), ...(wait ? { wait } : {}) });
  // Payout addresses the facilitators paid that no registry lists are watched as well, from this run on.
  if (Object.keys(facilitators || {}).length) await discoverAlgorand(s, { get, facilitators, today, log });
  const watch = [...new Set([...(payTos || []), ...Object.keys(s.found || {})].filter(watchable))];
  for (const a of watch) if (!s.pay_tos[a]) s.pay_tos[a] = { since: today, d: {}, round: null };
  const watched = new Set(watch);

  let added = 0, plain = 0, sent = 0, reached = 0;
  const order = watch.length ? [...watch.slice(s.cursor % watch.length), ...watch.slice(0, s.cursor % watch.length)] : [];
  let stoppedAt = null;
  for (const [i, payTo] of order.entries()) {
    if (now() - started > budgetMs) { stoppedAt = i; break; }
    const entry = s.pay_tos[payTo];
    try {
      // First sight: from the start of today; after that: every round since the last one read.
      const since = entry.round ? `min-round=${entry.round + 1}` : `after-time=${today}T00:00:00Z`;
      const { list, current, complete } = await transactionsOf(get, payTo, `asset-id=${USDC_ASA}&${since}`);
      for (const tx of [...list].reverse()) {
        const day = dayOf(Number.isFinite(Number(tx['round-time'])) ? Number(tx['round-time']) * 1000 : started);
        for (const p of paymentsOf(tx, payTo)) {
          if (p.dir === 'in' && !p.x402) { plain++; continue; }
          const d = (entry.d[day] ||= [0, 0, []]);
          if (p.dir === 'in') {
            d[0] += 1;
            d[1] += p.micro;
            const who = prefix(p.from);
            if (!d[2].includes(who) && d[2].length < MAX_PAYERS) d[2].push(who);
            added++;
          } else {
            const out = (d[3] ||= {});
            const to = prefix(p.to);
            if (to in out || Object.keys(out).length < MAX_RECIPIENTS) out[to] = (out[to] || 0) + p.micro;
            sent++;
          }
        }
      }
      // Remember where to go on: the indexer's round when the list was read to the end (nothing older is left), else
      // the newest round read (a very busy address loses the rest of that hour rather than counting it twice).
      const newest = Math.max(0, ...list.map((t) => Number(t['confirmed-round']) || 0));
      const round = complete && current ? Math.max(current, newest) : newest;
      if (round) entry.round = round;
      if (!complete) log(`${payTo}: more than ${MAX_PAGES * PAGE} transfers since the last run; the oldest were skipped`);
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
  log(`${added} x402 payments and ${sent} outgoing transfers added (${plain} transfers that paid their own fee left out); ${reached} of ${watch.length} payout addresses read${s.backlog ? `, ${s.backlog} left for the next run` : ''}`);
  return s;
}

module.exports = { ALGORAND, USDC_ASA, PUBLIC_INDEXER, FACILITATORS, isAlgorandUsdc, mergeAlgorandPayTos, collectAlgorand, paymentsOf, createIndexer };
