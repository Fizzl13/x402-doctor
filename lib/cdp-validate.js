// Coinbase's own check of an x402 endpoint: CDP's validate API (free, no key) says whether the CDP facilitator
// would index the route in the CDP Bazaar, which Coinbase's agents search. On their side it probes the URL once,
// pays nothing and indexes nothing. Answers are cached for 10 minutes, so repeated checks of one URL ask once.

const VALIDATE_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/validate';
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

function createCdpValidator({ url = process.env.CDP_VALIDATE_URL || VALIDATE_URL, fetchImpl = fetch, timeoutMs = 15000, now = Date.now } = {}) {
  const cache = new Map(); // `${method} ${resource}` -> { at, result }

  async function validate(resource, method = 'GET') {
    const key = `${method} ${resource}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.result;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource, method }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`CDP validate HTTP ${res.status}`);
    const result = await res.json();
    if (typeof result?.valid !== 'boolean' || !Array.isArray(result.preflight)) throw new Error('CDP validate: unexpected answer');
    cache.delete(key);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), result });
    return result;
  }

  return { validate };
}

// Once one check fails, CDP lists every later one as "Skipped: …"; only the real failures say what to fix.
function cdpFindings(result) {
  const failed = (result?.preflight || []).filter((c) => c && c.passed === false && !/^Skipped\b/i.test(String(c.detail || '')));
  return {
    accepted: result?.valid === true && result?.simulation?.outcome === 'accepted',
    required: failed.filter((c) => c.severity !== 'advisory'),
    advisory: failed.filter((c) => c.severity === 'advisory'),
    rejectionReason: result?.simulation?.outcome === 'rejected' ? result.simulation.rejectionReason || null : null,
  };
}

module.exports = { createCdpValidator, cdpFindings, VALIDATE_URL };
