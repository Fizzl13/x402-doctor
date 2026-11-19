// Public status of x402 facilitators (/facilitators, /api/v1/facilitators): which facilitators answer right now and
// which networks and schemes they settle. A seller picks one, a buyer's wallet depends on the seller's; when one is
// down (x402.semanticpay.io answered 500/503 on 16 Nov 2026, while Tether's WDK x402 guide sends USD₮0 payments on
// Plasma and Stable through it), nobody gets paid there. Free, read-only: each facilitator's public GET /supported,
// at most every PROBE_MS, run when someone looks. Never verifies or settles anything.

'use strict';

const { NETWORKS, V1_NAMES } = require('./networks');

// Public facilitators that answer GET /supported without a key. Coinbase's CDP facilitator needs an API key for
// /supported, so it is listed but not probed.
const FACILITATORS = [
  { id: 'payai', name: 'PayAI', url: 'https://facilitator.payai.network' },
  { id: 'fizzl', name: 'Fizzl (x402 Doctor)', url: 'https://x402-doctor.fizzl.eu/facilitator' },
  { id: 'x402-org', name: 'x402.org (testnets)', url: 'https://x402.org/facilitator' },
  { id: 'goplausible', name: 'GoPlausible', url: 'https://facilitator.goplausible.xyz' },
  { id: 'semanticpay', name: 'Semantic Pay', url: 'https://x402.semanticpay.io' },
  { id: 'x402-rs', name: 'x402.rs', url: 'https://facilitator.x402.rs' },
  { id: 'daydreams', name: 'Daydreams', url: 'https://facilitator.daydreams.systems' },
  { id: 'dexter', name: 'Dexter', url: 'https://x402.dexter.cash' },
  { id: 'openx402', name: 'OpenX402', url: 'https://facilitator.openx402.ai' },
  { id: 'mogami', name: 'Mogami', url: 'https://facilitator.mogami.tech' },
  { id: 'corbits', name: 'Corbits', url: 'https://facilitator.corbits.dev' },
  { id: 'heurist', name: 'Heurist', url: 'https://facilitator.heurist.xyz' },
  { id: 'cdp', name: 'Coinbase CDP', url: 'https://api.cdp.coinbase.com/platform/v2/x402', keyRequired: true },
];

const PROBE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const SLOW_MS = 5000;
const HISTORY = 48; // probes kept per facilitator (about four hours when someone looks every five minutes)
const UA = 'fizzl-facilitator-status/1.0 (+https://x402-doctor.fizzl.eu/facilitators)';

// v1 names and chains facilitators list that Doctor's own network table doesn't have (16 Nov 2026).
const MORE_NAMES = { xlayer: 'eip155:196', bsc: 'eip155:56', monad: 'eip155:143', sei: 'eip155:1329', world: 'eip155:480' };
const MORE_LABELS = { 'near:mainnet': 'NEAR', 'eip155:1329': 'Sei', 'eip155:480': 'World Chain', 'eip155:1187947933': 'SKALE Base' };
const TESTNETS = new Set(['near:testnet', 'eip155:1952', 'eip155:10143', 'eip155:713715', 'eip155:324705682', 'eip155:16602', 'aptos:2']);

// A network as CAIP-2 (x402 v1 names like "base" mapped), with a readable label when Doctor knows the chain.
function networkOf(raw) {
  let id = V1_NAMES[raw] || MORE_NAMES[raw] || raw;
  // Algorand's CAIP-2 id cuts the genesis hash to 32 characters; x402 v2 also uses the full hash. One network.
  if (/^algorand:/.test(id)) id = [V1_NAMES.algorand, V1_NAMES['algorand-testnet']].find((k) => k.startsWith(id) || id.startsWith(k)) || id;
  const known = NETWORKS[id];
  const testnet = known ? Boolean(known.testnet) : TESTNETS.has(id) || /sepolia|devnet|testnet|fuji|amoy/i.test(String(raw));
  return { id, name: known ? known.name : MORE_LABELS[id] || null, testnet };
}

// What a /supported answer says: the payment kinds (x402Version, scheme, network) and, for the networks, CAIP-2 ids.
function readSupported(body) {
  const kinds = Array.isArray(body && body.kinds) ? body.kinds.filter((k) => k && typeof k.network === 'string') : [];
  const networks = new Map();
  const schemes = new Set();
  const versions = new Set();
  for (const k of kinds) {
    const n = networkOf(k.network);
    const cur = networks.get(n.id) || { ...n, schemes: [] };
    if (k.scheme && !cur.schemes.includes(k.scheme)) cur.schemes.push(String(k.scheme).slice(0, 40));
    networks.set(n.id, cur);
    if (k.scheme) schemes.add(String(k.scheme).slice(0, 40));
    if (Number.isInteger(k.x402Version)) versions.add(k.x402Version);
  }
  return {
    kinds: kinds.length,
    networks: [...networks.values()].sort((a, b) => Number(a.testnet) - Number(b.testnet) || a.id.localeCompare(b.id)),
    schemes: [...schemes].sort(),
    x402_versions: [...versions].sort(),
  };
}

function createFacilitatorStatus({ fetchImpl = globalThis.fetch, now = () => Date.now(), facilitators = FACILITATORS } = {}) {
  let live = { at: 0, results: null };
  let probing = null;
  const history = new Map(facilitators.map((f) => [f.id, []]));
  const lastUp = new Map();

  async function probe(f) {
    if (f.keyRequired) return { state: 'not_checked', note: 'Needs an API key to list what it supports; not checked.' };
    const t = now();
    try {
      const res = await fetchImpl(`${f.url}/supported`, { headers: { accept: 'application/json', 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const ms = now() - t;
      const body = res.ok ? await res.json().catch(() => null) : (res.body?.cancel?.().catch?.(() => {}), null);
      if (!res.ok) return { state: 'down', ms, http: res.status, note: `GET /supported answers HTTP ${res.status}.` };
      const supported = readSupported(body);
      if (!supported.kinds) return { state: 'down', ms, http: res.status, note: 'GET /supported answers, but lists no payment kinds.' };
      const slow = ms > SLOW_MS;
      return { state: slow ? 'slow' : 'up', ms, http: res.status, note: slow ? `Answers, but slowly (${Math.round(ms / 100) / 10} s).` : `Answers, ${supported.kinds} payment kinds.`, ...supported };
    } catch (err) {
      return { state: 'down', ms: now() - t, note: err.name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} s.` : 'Not reachable.' };
    }
  }

  async function liveResults() {
    if (live.results && now() - live.at < PROBE_MS) return live;
    if (!probing) {
      probing = Promise.all(facilitators.map(probe))
        .then((results) => {
          const at = now();
          results.forEach((r, i) => {
            const f = facilitators[i];
            if (r.state === 'not_checked') return;
            const h = history.get(f.id);
            h.push({ at, up: r.state !== 'down' });
            if (h.length > HISTORY) h.shift();
            if (r.state !== 'down') lastUp.set(f.id, at);
          });
          live = { at, results };
        })
        .finally(() => { probing = null; });
    }
    await probing;
    return live;
  }

  // network: a CAIP-2 id or an x402 v1 name; only the facilitators that settle it (and answer now) are "for" it.
  async function snapshot({ network } = {}) {
    const { at, results } = await liveResults();
    const want = network ? networkOf(String(network).trim()).id : null;
    const list = facilitators.map((f, i) => {
      const r = results[i];
      const h = history.get(f.id) || [];
      const checks = h.length;
      return {
        id: f.id, name: f.name, url: f.url,
        state: r.state, note: r.note,
        ...(r.ms !== undefined && { response_ms: r.ms }),
        ...(r.http !== undefined && { http: r.http }),
        ...(r.networks && { networks: r.networks, schemes: r.schemes, x402_versions: r.x402_versions }),
        recent: checks ? { checks, up: h.filter((x) => x.up).length, since: new Date(h[0].at).toISOString() } : null,
        last_up: lastUp.has(f.id) ? new Date(lastUp.get(f.id)).toISOString() : null,
      };
    });
    const settles = (f) => f.networks && f.networks.some((n) => n.id === want);
    return {
      checked_at: new Date(at).toISOString(),
      next_check_after: new Date(at + PROBE_MS).toISOString(),
      how: 'GET {facilitator}/supported, read-only, at most every 5 minutes; up = answers 200 with at least one payment kind.',
      ...(want && {
        network: { ...networkOf(want), facilitators_up: list.filter((f) => settles(f) && f.state !== 'down').map((f) => f.id), facilitators_listed: list.filter(settles).map((f) => f.id) },
      }),
      up: list.filter((f) => f.state === 'up' || f.state === 'slow').length,
      down: list.filter((f) => f.state === 'down').length,
      facilitators: want ? list.filter(settles).concat(list.filter((f) => !settles(f))) : list,
    };
  }

  return { snapshot };
}

module.exports = { createFacilitatorStatus, readSupported, FACILITATORS };
