// Real payments on Solana: how many USDC payments, from how many different wallets, reached each Solana payout
// address in the Trust Index. A payment counts when its network fee was paid by a facilitator the sellers' own offers
// name (extra.feePayer), the way x402's exact scheme settles on Solana: the buyer signs the USDC transfer, the
// facilitator adds the fee and submits it. A plain transfer (the sender pays its own fee) doesn't count. Collected
// every hour by scripts/onchain-payments.js into payments-solana.json (payments-data branch), in the same shape as
// Base's payments.json, so lib/onchain-payments.js reads both. Read-only: it never pays and holds no key.
//
// Solana has no log filter over many accounts, so each payout address's USDC accounts are asked for their new
// transaction signatures (since the last one read), and each new transaction is read once. Accounts not reached in
// a run (rate limits, the time budget) are picked up by the next one: nothing is lost, it is only later.

const { isSolanaAddress } = require('./networks');

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const KEEP_DAYS = 8; // today and the 7 days before it, as on Base
const MAX_PAYERS = 5000;
const MAX_RECIPIENTS = 300;
const PAGE = 1000; // signatures per getSignaturesForAddress call
const MAX_PAGES = 5; // per account per run; a busier account continues next run
const ACCOUNTS_TTL_DAYS = 1; // ask again which USDC accounts a payout address has once a day

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefix = (a) => String(a).slice(0, 10); // tells wallets apart without listing them, as on Base
const watchable = (a) => isSolanaAddress(a);

// The Solana payout addresses (USDC offers) and facilitator fee payers the daily scan saw, kept for 14 days.
function mergeSolanaPayTos(previous, results, date, keepDays = 14) {
  const payTos = { ...(previous?.pay_tos || {}) }, feePayers = { ...(previous?.fee_payers || {}) };
  for (const r of results) {
    for (const a of r?.sol_pay_tos || []) if (watchable(a)) payTos[a] = date;
    for (const a of r?.sol_fee_payers || []) if (watchable(a)) feePayers[a] = date;
  }
  const cutoff = dayOf(Date.parse(`${date}T00:00:00Z`) - keepDays * 86400000);
  for (const m of [payTos, feePayers]) for (const [a, last] of Object.entries(m)) if (last < cutoff) delete m[a];
  return { network: SOLANA, updated: date, pay_tos: payTos, fee_payers: feePayers };
}

// JSON-RPC with a pace and patience. The public node counts calls per method: 10 per 10 seconds each for
// getSignaturesForAddress and getTransaction on its free tier (x-ratelimit-method-limit, 25 Oct 2026), and refused calls
// count as well. So calls of one method keep methodGapMs apart, and a 429 is waited out for the seconds its Retry-After
// names: retrying sooner only extends the refusal (the first run, on 25 Oct, stopped after 10 transactions). A node that
// keeps refusing hands over to the next; the last error is thrown.
function createRpc(nodes, { fetchImpl = fetch, minGapMs = 350, methodGapMs = 0, retries = 3, wait = sleep } = {}) {
  let lastAt = 0;
  const methodAt = new Map();
  return async function rpc(method, params) {
    let last;
    for (const url of nodes) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const gap = Math.max(lastAt + minGapMs, (methodAt.get(method) || 0) + methodGapMs) - Date.now();
        if (gap > 0) await wait(gap);
        lastAt = Date.now();
        methodAt.set(method, lastAt);
        let retryAfterMs = 0;
        try {
          const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
          const body = await res.json().catch(() => null);
          if (body && 'result' in body && !body.error) return body.result;
          last = new Error(body?.error?.message || `HTTP ${res.status}`);
          if (res.status !== 429 && !/too many|rate/i.test(last.message)) break; // not a rate limit: next node
          retryAfterMs = (Number(res.headers?.get?.('retry-after')) || 0) * 1000;
        } catch (err) {
          last = err;
        }
        await wait(Math.max(1000 * 2 ** attempt, retryAfterMs));
      }
    }
    throw last;
  };
}

const emptyState = () => ({ version: 1, network: SOLANA, token: USDC_MINT, per_day: 1, updated: null, cursor: 0, days: {}, pay_tos: {} });

// The USDC transfers in one parsed transaction, with the owners of the accounts involved (from the token balances).
function transfersOf(tx) {
  const keys = (tx?.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const owners = new Map(), mints = new Map();
  for (const b of [...(tx?.meta?.preTokenBalances || []), ...(tx?.meta?.postTokenBalances || [])]) {
    const acct = keys[b.accountIndex];
    if (!acct) continue;
    if (b.owner) owners.set(acct, b.owner);
    if (b.mint) mints.set(acct, b.mint);
  }
  const all = [...(tx?.transaction?.message?.instructions || []), ...(tx?.meta?.innerInstructions || []).flatMap((i) => i.instructions || [])];
  const out = [];
  for (const ix of all) {
    const p = ix?.parsed;
    if (!p || !/^spl-token/.test(ix.program || '') || !['transfer', 'transferChecked'].includes(p.type)) continue;
    const info = p.info || {};
    const mint = info.mint || mints.get(info.destination) || mints.get(info.source);
    if (mint !== USDC_MINT) continue;
    const amount = Number(info.tokenAmount?.amount ?? info.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.push({ source: info.source, destination: info.destination, authority: info.authority || info.multisigAuthority, amount, to: owners.get(info.destination) || null });
  }
  return { feePayer: keys[0] || null, transfers: out };
}

// Reads what is new on the watched payout addresses' USDC accounts and adds each facilitator-paid USDC payment to its
// day (and USDC sent out of them, per recipient, for the closed-loop check). Stops at the time budget; the next run
// goes on where this one stopped.
async function collectSolana(state, { payTos, feePayers, nodes = [PUBLIC_RPC], fetchImpl = fetch, now = Date.now, budgetMs = 12 * 60 * 1000, minGapMs, methodGapMs, wait, log = () => {} } = {}) {
  const s = state?.version === 1 && state.network === SOLANA ? JSON.parse(JSON.stringify(state)) : emptyState();
  const started = now();
  const today = dayOf(started);
  const rpc = createRpc(nodes, { fetchImpl, ...(minGapMs !== undefined ? { minGapMs } : {}), ...(methodGapMs !== undefined ? { methodGapMs } : {}), ...(wait ? { wait } : {}) });
  const watch = [...new Set((payTos || []).filter(watchable))];
  const facilitators = new Set((feePayers || []).filter(watchable));
  for (const a of watch) if (!s.pay_tos[a]) s.pay_tos[a] = { since: today, d: {}, accounts: null, accounts_at: null, last: {} };
  const watched = new Set(watch);
  // On first sight an account is read from the start of today, not its whole history.
  const floor = Date.parse(`${today}T00:00:00Z`) / 1000;

  let added = 0, sent = 0, reached = 0, txRead = 0;
  const order = watch.length ? [...watch.slice(s.cursor % watch.length), ...watch.slice(0, s.cursor % watch.length)] : [];
  let stoppedAt = null;
  for (const [i, payTo] of order.entries()) {
    if (now() - started > budgetMs) { stoppedAt = i; break; }
    const entry = s.pay_tos[payTo];
    try {
      if (!entry.accounts || !entry.accounts_at || entry.accounts_at < dayOf(started - ACCOUNTS_TTL_DAYS * 86400000)) {
        const r = await rpc('getTokenAccountsByOwner', [payTo, { mint: USDC_MINT }, { encoding: 'jsonParsed' }]);
        entry.accounts = (r?.value || []).map((v) => v.pubkey).filter(watchable);
        entry.accounts_at = today;
      }
      const mine = new Set(entry.accounts);
      for (const acct of entry.accounts) {
        // New signatures since the last one read, newest first; on first sight, today's only.
        const fresh = [];
        let before;
        for (let page = 0; page < MAX_PAGES; page++) {
          const sigs = await rpc('getSignaturesForAddress', [acct, { limit: PAGE, ...(entry.last[acct] ? { until: entry.last[acct] } : {}), ...(before ? { before } : {}) }]);
          const usable = entry.last[acct] ? sigs : sigs.filter((x) => (x.blockTime || 0) >= floor);
          fresh.push(...usable);
          if (sigs.length < PAGE || usable.length < sigs.length) break;
          before = sigs.at(-1).signature;
        }
        // Oldest first, so the last one read is the newest when a run is cut short.
        for (const sig of fresh.reverse()) {
          if (sig.err) { entry.last[acct] = sig.signature; continue; }
          const tx = await rpc('getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
          txRead++;
          const day = dayOf((tx?.blockTime ?? sig.blockTime ?? started / 1000) * 1000);
          const { feePayer, transfers } = transfersOf(tx);
          for (const t of transfers) {
            if (mine.has(t.destination) && !mine.has(t.source) && t.authority && t.authority !== payTo && feePayer && feePayer !== t.authority && facilitators.has(feePayer)) {
              const d = (entry.d[day] ||= [0, 0, []]);
              d[0] += 1;
              d[1] += t.amount;
              const p = prefix(t.authority);
              if (!d[2].includes(p) && d[2].length < MAX_PAYERS) d[2].push(p);
              added++;
            } else if (mine.has(t.source) && !mine.has(t.destination) && t.to && t.to !== payTo) {
              const d = (entry.d[day] ||= [0, 0, []]);
              const out = (d[3] ||= {});
              const to = prefix(t.to);
              if (to in out || Object.keys(out).length < MAX_RECIPIENTS) out[to] = (out[to] || 0) + t.amount;
              sent++;
            }
          }
          entry.last[acct] = sig.signature;
          if (now() - started > budgetMs) break;
        }
        // Nothing new and never read: remember the newest signature, so the next run starts from here.
        if (!entry.last[acct] && !fresh.length) {
          const newest = await rpc('getSignaturesForAddress', [acct, { limit: 1 }]);
          if (newest[0]) entry.last[acct] = newest[0].signature;
        }
      }
      reached++;
    } catch (err) {
      log(`${payTo}: ${err.message}`);
      if (/too many|rate/i.test(err.message)) { stoppedAt = i; break; }
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
  log(`${added} facilitator-paid payments and ${sent} outgoing transfers added; ${reached} of ${watch.length} payout addresses read, ${txRead} transactions${s.backlog ? `, ${s.backlog} left for the next run` : ''}`);
  return s;
}

module.exports = { SOLANA, USDC_MINT, PUBLIC_RPC, mergeSolanaPayTos, collectSolana, transfersOf, createRpc };
