// The OFAC SDN list's digital currency addresses, to screen where a buyer's money would go: the payTo of an
// x402 option and the recipient of an MPP option. Paying a listed address is a sanctions violation for US
// persons, whatever the service, so a listed payTo makes the preflight answer no_go.
//
// The list is presign-guard's free open copy (GET /v1/sanctions: every crypto address the US Treasury publishes
// in SDN.XML, refreshed there every 6 hours), held in memory and fetched again every 6 hours. Lookups are exact:
// EVM and bech32 addresses lowercased, base58 (Solana, Tron, XRPL) and Algorand addresses as they are.

const LIST_URL = 'https://presign-guard.fizzl.eu/v1/sanctions';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const USER_AGENT = `x402-doctor/${require('../package.json').version} (sanctions list; +https://x402-doctor.fizzl.eu)`;

function addressKey(address) {
  const a = String(address).trim();
  return /^0x[0-9a-f]{40}$/i.test(a) || /^(bc1|ltc1|tb1)[0-9a-z]+$/i.test(a) ? a.toLowerCase() : a;
}

const DISABLED = { enabled: false, ready: async () => null, check: () => null, status: () => ({ enabled: false }) };

// list: the list JSON itself (tests); SANCTIONS=off turns screening off. Under `node --test` it is off unless a
// test passes a list or its own fetch, so the test suite never downloads the real list.
function createSanctions({ env = process.env, url = env.SANCTIONS_LIST_URL || LIST_URL, fetchImpl = globalThis.fetch, list = null, refreshMs = REFRESH_MS, now = () => Date.now() } = {}) {
  if (!list && (env.SANCTIONS === 'off' || (process.env.NODE_TEST_CONTEXT && fetchImpl === globalThis.fetch))) return DISABLED;
  let state = null; // { index: Map, published, count, loadedAt }
  let loading = null;
  let lastAttempt = -Infinity;
  let lastError = null;
  const use = (body) => {
    if (!body || !Array.isArray(body.addresses) || body.addresses.length === 0) throw new Error('not a sanctions list');
    const index = new Map(body.addresses.map((a) => [addressKey(a.address), a.entries ?? []]));
    state = { index, published: body.published ?? null, count: index.size, loadedAt: now() };
    lastError = null;
  };
  if (list) use(list);
  const load = () => {
    if (loading) return loading;
    lastAttempt = now();
    loading = (async () => {
      try {
        const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        use(await res.json());
      } catch (err) {
        lastError = String(err?.message ?? err).slice(0, 160);
        console.error('[sanctions] list unavailable:', lastError);
      }
      return state;
    })().finally(() => { loading = null; });
    return loading;
  };
  // The list, loading it the first time (waiting at most waitMs), refreshing it in the background when it is older
  // than refreshMs, and trying again at most once a minute while it can't be had.
  async function ready({ waitMs = 3000 } = {}) {
    if (state && now() - state.loadedAt > refreshMs && now() - lastAttempt > RETRY_MS) load();
    if (state) return state;
    const pending = loading || (now() - lastAttempt > RETRY_MS ? load() : null);
    if (!pending) return null;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    enabled: true,
    ready,
    /** { listed, entries, published } for an address, or null while no list is loaded. */
    check(address) {
      if (!state || !address) return null;
      const entries = state.index.get(addressKey(address)) ?? [];
      return { listed: entries.length > 0, entries, published: state.published };
    },
    status: () => ({ enabled: true, addresses: state?.count ?? 0, published: state?.published ?? null, ...(lastError && { lastError }) }),
  };
}

// "NAME (PROGRAM, PROGRAM)" for the first two SDN entries of a listed address.
function describeEntries(entries) {
  return (entries || []).slice(0, 2).map((e) => `${e.name}${e.programs?.length ? ` (${e.programs.join(', ')})` : ''}`).join('; ') || 'an SDN entry';
}

module.exports = { createSanctions, addressKey, describeEntries, LIST_URL, USER_AGENT };
