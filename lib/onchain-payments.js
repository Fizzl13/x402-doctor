// Real payments on chain: how many USDC payments, from how many different wallets, reached each payout address in
// the Trust Index on Base. Only transfers the payer signed with EIP-3009 (transferWithAuthorization, the way x402's
// exact scheme settles USDC) count; plain transfers, Permit2 and Circle Gateway batches don't. x402 Doctor's own test
// wallet is left out. Collected every hour by scripts/onchain-payments.js (payments.json on the payments-data branch);
// the preflight and /trust read it here. A signal only: new sellers start at zero.
//
// Closed loops: USDC sent out of a payout address is read too, per recipient. A payer that also received USDC from
// the payout address it paid is "paid back"; when every ordinary payer of a seller was paid back, and at least half
// of what came in went back to them, the count is a closed loop (a seller paying its own endpoint and sweeping the
// money back looks on chain like a busy seller). A sweep through a third wallet isn't seen.
//
// Solana's counts (lib/onchain-payments-solana.js, payments-solana.json) and the XRP Ledger's
// (lib/onchain-payments-xrpl.js, payments-xrpl.json, in RLUSD or USDC) and Stellar's (lib/onchain-payments-stellar.js,
// payments-stellar.json) have the same shape and are read here too.

const { isEvmAddress, isSolanaAddress, isXrplAddress, isStellarAddress, burnAddress } = require('./networks');

const BASE = 'eip155:8453';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const AUTH_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'; // AuthorizationUsed(address,bytes32)
const BLOCK_SECONDS = 2; // Base makes a block every 2 seconds, so a block's time follows from one reference block
const BLOCKS_PER_DAY = 86400 / BLOCK_SECONDS;
const PUBLIC_RPC = 'https://base-rpc.publicnode.com'; // serves logs for roughly the last 10,000 blocks without a key
const ARCHIVE_SAFE = 9000; // blocks the public node still serves; older ones need BASE_RPC_URL
const KEEP_DAYS = 8; // today and the 7 days before it
const WINDOW_DAYS = 7;
const MAX_PAYERS = 5000; // per payout address per day; more is reported as "at least"
const MAX_RECIPIENTS = 300; // wallets a payout address sent USDC to, per day (only payers among them matter)
// A wallet that paid this many different payout addresses in the window: a checker, scanner or test harness, not an
// ordinary buyer. On 21 Oct 2026, 19 such wallets were the only payers of 522 of the 926 payout addresses paid.
const WIDE_SELLERS = 10;
const OWN_PAYERS = new Set(['0xa12871853f653f76ec303b94ac4fb6c46578a3f1']); // x402 Doctor's spot-buy and index-payment wallet

const DATA_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/payments-data/payments.json';
const SOLANA_DATA_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/payments-data/payments-solana.json';
const XRPL_DATA_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/payments-data/payments-xrpl.json';
// Who the XRPL payout addresses are (hub merchant names, endpoint hosts), from the daily scan.
const XRPL_PAYTOS_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/paytos-xrpl.json';
const STELLAR_DATA_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/payments-data/payments-stellar.json';
// The hosts of the Trust Index endpoints that pay to each Stellar payout account, from the daily scan.
const STELLAR_PAYTOS_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/paytos-stellar.json';
const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

const lc = (a) => String(a).toLowerCase();
// EVM addresses are kept lowercase; Solana's base58 addresses are case-sensitive and kept as they are.
const keyOf = (a) => (isEvmAddress(a) ? lc(a) : String(a));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const pad = (a) => `0x${lc(a).slice(2).padStart(64, '0')}`;
const addrOf = (topic) => `0x${String(topic).slice(26).toLowerCase()}`;
const hex = (n) => `0x${n.toString(16)}`;
const groups = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const watchable = (a) => isEvmAddress(a) && !burnAddress(a);

// The payout addresses on Base the daily scan saw (scan results' pay_tos), kept for 14 days after they were last seen.
function mergePayTos(previous, results, date, keepDays = 14) {
  const seen = { ...(previous?.pay_tos || {}) };
  for (const r of results) for (const a of r?.pay_tos || []) if (watchable(a)) seen[lc(a)] = date;
  const cutoff = dayOf(Date.parse(`${date}T00:00:00Z`) - keepDays * 86400000);
  for (const [a, last] of Object.entries(seen)) if (last < cutoff) delete seen[a];
  return { network: BASE, updated: date, pay_tos: seen };
}

// One JSON-RPC call, tried on each node in turn. A node that refuses (rate limit, range, no archive) hands over to
// the next; the last error is thrown.
async function rpc(nodes, method, params, fetchImpl) {
  let last;
  for (const url of nodes) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      const body = await res.json().catch(() => null);
      if (body && 'result' in body && !body.error) return body.result;
      last = new Error(body?.error?.message || `HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const emptyState = () => ({ version: 1, network: BASE, token: USDC, updated: null, last_block: null, days: {}, pay_tos: {} });

// Reads the blocks since the last run and adds every signed USDC payment to a watched payout address to its day.
// Blocks the nodes can no longer serve are skipped and show up as lower coverage for their day.
async function collect(state, { payTos, nodes = [PUBLIC_RPC], fetchImpl = fetch, now = Date.now, chunk = 2000, archiveSafe = ARCHIVE_SAFE, confirmations = 10, maxBlocks = 60000, log = () => {} } = {}) {
  const s = state?.version === 1 ? JSON.parse(JSON.stringify(state)) : emptyState();
  const today = dayOf(now());
  const watch = [...new Set((payTos || []).filter(watchable).map(lc))];
  for (const a of watch) if (!s.pay_tos[a]) s.pay_tos[a] = { since: today, d: {} };
  const watched = new Set(watch);

  const head = parseInt(await rpc(nodes, 'eth_blockNumber', [], fetchImpl), 16) - confirmations;
  const headTs = parseInt((await rpc(nodes, 'eth_getBlockByNumber', [hex(head), false], fetchImpl)).timestamp, 16);
  const tsOf = (b) => (headTs - BLOCK_SECONDS * (head - b)) * 1000;
  let from = s.last_block === null ? head - archiveSafe : s.last_block + 1;
  if (head - from > maxBlocks) {
    log(`blocks ${from}-${head - maxBlocks - 1} skipped (more than ${maxBlocks} behind)`);
    from = head - maxBlocks;
  }

  const getLogs = (filter) => rpc(nodes, 'eth_getLogs', [filter], fetchImpl);
  async function signedPayments(a, b) {
    const range = { fromBlock: hex(a), toBlock: hex(b) };
    const transfers = [];
    for (const g of groups(watch, 1000)) transfers.push(...await getLogs({ address: USDC, topics: [TRANSFER, null, g.map(pad)], ...range }));
    const payers = [...new Set(transfers.map((l) => addrOf(l.topics[1])))].filter((p) => !OWN_PAYERS.has(p));
    const signed = new Set();
    for (const g of groups(payers, 1000)) for (const l of await getLogs({ address: USDC, topics: [AUTH_USED, g.map(pad)], ...range })) signed.add(`${l.transactionHash}|${addrOf(l.topics[1])}`);
    const pays = transfers.filter((l) => {
      const payer = addrOf(l.topics[1]), to = addrOf(l.topics[2]);
      return payer !== to && !OWN_PAYERS.has(payer) && watched.has(to) && signed.has(`${l.transactionHash}|${payer}`);
    });
    // USDC leaving the payout addresses, signed or not: a sweep back to the wallet that paid is a plain transfer.
    const outs = [];
    for (const g of groups(watch, 1000)) outs.push(...await getLogs({ address: USDC, topics: [TRANSFER, g.map(pad)], ...range }));
    return { pays, outs: outs.filter((l) => watched.has(addrOf(l.topics[1])) && addrOf(l.topics[1]) !== addrOf(l.topics[2])) };
  }
  // A range the node won't serve in one go (too many results, too wide): halve it. Rate limits and missing archive
  // data are not helped by that and go straight up.
  const tooBig = (err) => /range|results|response size|too large|exceed/i.test(err?.message || '') && !/rate|request limit|archive/i.test(err?.message || '');
  async function read(a, b) {
    try {
      return await signedPayments(a, b);
    } catch (err) {
      if (b - a < 50 || !tooBig(err)) throw err;
      const mid = Math.floor((a + b) / 2);
      const [x, y] = [await read(a, mid), await read(mid + 1, b)];
      return { pays: [...x.pays, ...y.pays], outs: [...x.outs, ...y.outs] };
    }
  }
  function cover(a, b) {
    while (a <= b) {
      const ts = tsOf(a);
      const day = dayOf(ts);
      const nextMidnight = Date.parse(`${day}T00:00:00Z`) + 86400000;
      const end = Math.min(b, a + Math.ceil((nextMidnight - ts) / 1000 / BLOCK_SECONDS) - 1);
      s.days[day] = { covered: (s.days[day]?.covered || 0) + (end - a + 1) };
      a = end + 1;
    }
  }

  let added = 0, sent = 0;
  for (let a = from; a <= head; ) {
    const b = Math.min(a + chunk - 1, head);
    let logs, outs;
    try {
      ({ pays: logs, outs } = await read(a, b));
    } catch (err) {
      if (head - a > archiveSafe) {
        log(`blocks ${a}-${head - archiveSafe - 1} skipped: ${err.message}`);
        a = head - archiveSafe;
        continue;
      }
      log(`stopped at block ${a}: ${err.message}`);
      break;
    }
    for (const l of logs) {
      const entry = s.pay_tos[addrOf(l.topics[2])];
      const day = dayOf(tsOf(parseInt(l.blockNumber, 16)));
      const d = (entry.d[day] ||= [0, 0, []]);
      d[0] += 1;
      d[1] += Number(BigInt(l.data));
      const payer = addrOf(l.topics[1]).slice(2, 12); // a 40-bit prefix tells payers apart without listing them
      if (!d[2].includes(payer) && d[2].length < MAX_PAYERS) d[2].push(payer);
      added++;
    }
    // d[3]: micro-USDC the payout address sent that day, per recipient (40-bit prefix).
    for (const l of outs) {
      const entry = s.pay_tos[addrOf(l.topics[1])];
      const day = dayOf(tsOf(parseInt(l.blockNumber, 16)));
      const d = (entry.d[day] ||= [0, 0, []]);
      const out = (d[3] ||= {});
      const to = addrOf(l.topics[2]).slice(2, 12);
      if (to in out || Object.keys(out).length < MAX_RECIPIENTS) out[to] = (out[to] || 0) + Number(BigInt(l.data));
      sent++;
    }
    cover(a, b);
    s.last_block = b;
    a = b + 1;
  }

  // Keep today and the 7 days before it; forget payout addresses that are no longer listed and have nothing left.
  const cutoff = dayOf(Date.parse(`${today}T00:00:00Z`) - (KEEP_DAYS - 1) * 86400000);
  for (const day of Object.keys(s.days)) if (day < cutoff) delete s.days[day];
  for (const [a, entry] of Object.entries(s.pay_tos)) {
    for (const day of Object.keys(entry.d)) if (day < cutoff) delete entry.d[day];
    if (!watched.has(a) && !Object.keys(entry.d).length) delete s.pay_tos[a];
  }
  s.updated = new Date(now()).toISOString();
  log(`${added} signed payments and ${sent} outgoing transfers added, up to block ${s.last_block}`);
  return s;
}

// The complete days the window covers: the 7 days before the day of the last update that have data.
function windowDays(state, days = WINDOW_DAYS) {
  if (!state?.updated) return [];
  const today = state.updated.slice(0, 10);
  const out = [];
  for (let i = days; i >= 1; i--) {
    const day = dayOf(Date.parse(`${today}T00:00:00Z`) - i * 86400000);
    if (state.days[day]?.covered) out.push(day);
  }
  return out;
}

// The payers that paid WIDE_SELLERS or more payout addresses in these days, worked out once per file and window.
const wideCache = new WeakMap();
function widePayers(state, days) {
  const key = days.join();
  const cached = wideCache.get(state);
  if (cached?.key === key) return cached.wide;
  const sellers = new Map();
  for (const entry of Object.values(state.pay_tos)) {
    const mine = new Set();
    for (const day of days) if (entry.d[day] && day >= entry.since) for (const p of entry.d[day][2]) mine.add(p);
    for (const p of mine) sellers.set(p, (sellers.get(p) || 0) + 1);
  }
  const wide = new Set([...sellers].filter(([, n]) => n >= WIDE_SELLERS).map(([p]) => p));
  wideCache.set(state, { key, wide });
  return wide;
}

// One payout address over these days: its payers, and those it sent USDC back to (with how much).
function loopOf(entry, days, wide) {
  const payers = new Set(), sentTo = new Map();
  let micro = 0;
  for (const day of days) {
    const d = entry.d[day];
    if (!d || day < entry.since) continue;
    micro += d[1];
    for (const p of d[2]) payers.add(p);
    for (const [to, v] of Object.entries(d[3] || {})) sentTo.set(to, (sentTo.get(to) || 0) + v);
  }
  const back = [...payers].filter((p) => sentTo.has(p));
  const backMicro = back.reduce((n, p) => n + sentTo.get(p), 0);
  const ordinary = [...payers].filter((p) => !wide.has(p));
  // Closed: every ordinary payer was paid back, and at least half of what came in went back to them.
  const closed = ordinary.length > 0 && ordinary.every((p) => sentTo.has(p)) && backMicro * 2 >= micro;
  return { back, backMicro, closed };
}

function sumOf(state, entries, days) {
  let payments = 0, micro = 0, capped = false, backMicro = 0;
  const payers = new Set(), back = new Set();
  const wide = widePayers(state, days);
  for (const entry of entries) {
    for (const day of days) {
      const d = entry.d[day];
      if (!d || day < entry.since) continue;
      payments += d[0];
      micro += d[1];
      for (const p of d[2]) payers.add(p);
      if (d[2].length >= MAX_PAYERS) capped = true;
    }
    const loop = loopOf(entry, days, wide);
    for (const p of loop.back) back.add(p);
    backMicro += loop.backMicro;
  }
  const covered = days.reduce((n, day) => n + state.days[day].covered, 0);
  // Base counts blocks read per day; Solana marks a day read (per_day 1), since a missed run is caught up later.
  const perDay = state.per_day || BLOCKS_PER_DAY;
  // payers_wide: how many of these payers paid WIDE_SELLERS or more payout addresses in the same days.
  // payers_paid_back: how many received USDC from a payout address they paid; usd_paid_back: how much.
  return {
    payments, payers: payers.size, ...(capped ? { payers_at_least: true } : {}), payers_wide: [...payers].filter((p) => wide.has(p)).length,
    payers_paid_back: back.size, usd_paid_back: Math.round(backMicro / 1e4) / 100,
    usd: Math.round(micro / 1e4) / 100, coverage: Math.min(1, Math.round((covered / (days.length * perDay)) * 1000) / 1000),
  };
}

// The token the counts are in, when it isn't USDC (the XRP Ledger's are in RLUSD or USDC).
const symbolOf = (state) => (state.symbol ? { symbol: state.symbol } : {});

// One payout address over the window, or null when it isn't watched or there is no complete day yet.
function windowOf(state, payTo) {
  const entry = state?.pay_tos?.[keyOf(payTo)];
  if (!entry) return null;
  const days = windowDays(state).filter((day) => day >= entry.since);
  if (!days.length) return null;
  const closed = loopOf(entry, days, widePayers(state, days)).closed;
  return { network: state.network || BASE, ...symbolOf(state), pay_to: keyOf(payTo), days: days.length, ...sumOf(state, [entry], days), ...(closed ? { closed_loop: true } : {}), as_of: state.updated };
}

// All watched payout addresses together, for /trust and the summary.
function totalsOf(state) {
  const days = windowDays(state);
  if (!days.length) return null;
  const entries = Object.values(state.pay_tos);
  const paid = entries.filter((e) => days.some((day) => e.d[day]?.[0] > 0 && day >= e.since));
  // Payout addresses whose every payer in the window paid WIDE_SELLERS or more of them: no ordinary buyer seen.
  const wide = widePayers(state, days);
  const onlyWide = paid.filter((e) => days.every((day) => !e.d[day] || day < e.since || e.d[day][2].every((p) => wide.has(p)))).length;
  const closed = paid.filter((e) => loopOf(e, days, wide).closed).length;
  return { network: state.network || BASE, ...symbolOf(state), days: days.length, watched: entries.length, pay_tos_paid: paid.length, pay_tos_paid_only_wide: onlyWide, pay_tos_closed_loop: closed, wide_sellers: WIDE_SELLERS, ...sumOf(state, entries, days), as_of: state.updated };
}

// Every watched payout address that was paid in the window, most money first, with who it is when the daily scan
// knows (`info`: paytos-xrpl.json's names from the XRPL AI Hub and hosts of Trust Index endpoints, or
// paytos-stellar.json's hosts). For the public
// list of who gets paid (GET /api/trust/payments); null when there is no complete day yet.
function sellersOf(state, info = null, { limit = 200 } = {}) {
  const days = windowDays(state);
  if (!days.length) return null;
  const sellers = [];
  for (const payTo of Object.keys(state.pay_tos)) {
    const w = windowOf(state, payTo);
    if (!w?.payments) continue;
    sellers.push({
      pay_to: w.pay_to, name: info?.names?.[payTo] || null, hosts: info?.hosts?.[payTo] || [],
      payments: w.payments, usd: w.usd, payers: w.payers, ...(w.payers_at_least ? { payers_at_least: true } : {}), payers_wide: w.payers_wide,
      ...(w.closed_loop ? { closed_loop: true } : {}),
    });
  }
  sellers.sort((a, b) => b.usd - a.usd || b.payments - a.payments);
  return { network: state.network || BASE, ...symbolOf(state), days, watched: Object.keys(state.pay_tos).length, paid: sellers.length, wide_sellers: WIDE_SELLERS, sellers: sellers.slice(0, limit), as_of: state.updated };
}

// The sentence the preflight and the web check add about payers this payout address sent USDC back to.
function paidBackNote(w) {
  const back = w?.payers_paid_back || 0;
  const token = w?.symbol || 'USDC';
  if (w?.closed_loop) return ` Every ordinary payer also received ${token} back from this payout address ($${w.usd_paid_back} of the $${w.usd} paid in): this looks like the seller paying its own endpoint, not outside demand.`;
  if (back) return ` ${back === 1 ? 'One of these wallets' : `${back} of these wallets`} also received ${token} from this payout address ($${w.usd_paid_back}), such as refunds or the seller's own wallets.`;
  return '';
}

function createOnchainPayments({ url = process.env.ONCHAIN_PAYMENTS_URL || DATA_URL, solanaUrl = process.env.ONCHAIN_PAYMENTS_SOLANA_URL || SOLANA_DATA_URL, xrplUrl = process.env.ONCHAIN_PAYMENTS_XRPL_URL || XRPL_DATA_URL, xrplPayTosUrl = process.env.XRPL_PAYTOS_URL || XRPL_PAYTOS_URL, stellarUrl = process.env.ONCHAIN_PAYMENTS_STELLAR_URL || STELLAR_DATA_URL, stellarPayTosUrl = process.env.STELLAR_PAYTOS_URL || STELLAR_PAYTOS_URL, fetchImpl = fetch, now = Date.now } = {}) {
  // Tests never download the real file unless they pass their own fetch.
  const disabled = Boolean(process.env.NODE_TEST_CONTEXT) && fetchImpl === globalThis.fetch;
  let state = { at: 0, data: null, solana: null, xrpl: null, xrplInfo: null, stellar: null, stellarInfo: null };
  let loading = null;

  // Base's file is required; Solana's, the XRP Ledger's and Stellar's are read when they are there (they start later, and a
  // missing one isn't an error).
  const load = async (u, required) => {
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) { if (required) throw new Error(`payments HTTP ${res.status}`); return null; }
    const data = await res.json();
    return data?.version === 1 ? data : null;
  };
  function refresh() {
    if (disabled) return Promise.resolve();
    if (!loading) {
      loading = (async () => {
        const optional = (u) => (u ? load(u, false).catch(() => null) : null);
        const info = async (u) => {
          const res = u ? await fetchImpl(u, { signal: AbortSignal.timeout(30000) }).catch(() => null) : null;
          return res?.ok ? res.json().catch(() => null) : null;
        };
        const [data, solana, xrpl, xrplInfo, stellar, stellarInfo] = await Promise.all([load(url, true), optional(solanaUrl), optional(xrplUrl), info(xrplPayTosUrl), optional(stellarUrl), info(stellarPayTosUrl)]);
        state = { at: now(), data, solana, xrpl, xrplInfo: xrplInfo || state.xrplInfo, stellar, stellarInfo: stellarInfo || state.stellarInfo };
      })()
        .catch((err) => { state = { ...state, at: now() - TTL_MS + RETRY_MS }; console.error('[onchain-payments] refresh failed:', err.message); })
        .finally(() => { loading = null; });
    }
    return loading;
  }
  const dataFor = (payTo) => (isStellarAddress(payTo, 'G') ? state.stellar : isXrplAddress(payTo) ? state.xrpl : isSolanaAddress(payTo) && !isEvmAddress(payTo) ? state.solana : state.data);

  async function fresh(waitMs) {
    if (!state.at || now() - state.at > TTL_MS) {
      const pending = refresh();
      if (!state.data && waitMs > 0) await Promise.race([pending, new Promise((r) => setTimeout(r, waitMs))]);
    }
  }

  return {
    refresh,
    async lookup(payTo, { waitMs = 0 } = {}) { await fresh(waitMs); const d = dataFor(payTo); return d ? windowOf(d, payTo) : null; },
    async totals({ waitMs = 0 } = {}) { await fresh(waitMs); return state.data ? totalsOf(state.data) : null; },
    async totalsSolana({ waitMs = 0 } = {}) { await fresh(waitMs); return state.solana ? totalsOf(state.solana) : null; },
    async totalsXrpl({ waitMs = 0 } = {}) { await fresh(waitMs); return state.xrpl ? totalsOf(state.xrpl) : null; },
    // The XRPL payout addresses paid in the window, with names (GET /api/trust/payments?network=xrpl).
    async sellersXrpl({ waitMs = 0, limit } = {}) { await fresh(waitMs); return state.xrpl ? sellersOf(state.xrpl, state.xrplInfo, { limit }) : null; },
    async totalsStellar({ waitMs = 0 } = {}) { await fresh(waitMs); return state.stellar ? totalsOf(state.stellar) : null; },
    // The Stellar payout accounts paid in the window, with their endpoints' hosts (GET /api/trust/payments?network=stellar).
    async sellersStellar({ waitMs = 0, limit } = {}) { await fresh(waitMs); return state.stellar ? sellersOf(state.stellar, state.stellarInfo, { limit }) : null; },
    // Whether the counts for this payout address's network are loaded (Base without an address): lookup's null then
    // means the payout address isn't watched (or not for a full day).
    loaded: (payTo) => Boolean(payTo ? dataFor(payTo) : state.data),
  };
}

module.exports = { BASE, USDC, TRANSFER, AUTH_USED, PUBLIC_RPC, OWN_PAYERS, WIDE_SELLERS, mergePayTos, collect, windowOf, totalsOf, sellersOf, paidBackNote, createOnchainPayments };
