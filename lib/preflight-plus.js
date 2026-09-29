// Two variants of the pre-payment check (preflight.js):
//
// batch: up to 10 endpoints in one call, e.g. a marketplace or an agent that
//   weighs several services. Each URL gets the same verdict as a single
//   preflight; a URL that errors or times out is "unknown" and does not hold
//   up the rest.
// deep: one endpoint, for expensive calls. The preflight verdict plus the full
//   diagnosis, the 30-day history per day, the seller's other endpoints on the
//   same origin and whether the endpoint moved domains.

const BATCH_MAX = 10;
const BATCH_TIMEOUT_MS = 20000;
const STATUS = { g: 'go', c: 'caution', n: 'no_go', x: 'unreachable', '-': null };

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function batchPreflight(urls, { runPreflight, method, maxUsd, network, timeoutMs = BATCH_TIMEOUT_MS } = {}) {
  const unique = [...new Set(urls.map(String))];
  if (unique.length === 0) throw Object.assign(new Error('give at least one url'), { statusCode: 400 });
  if (unique.length > BATCH_MAX) throw Object.assign(new Error(`at most ${BATCH_MAX} urls per batch`), { statusCode: 400 });
  const results = await Promise.all(
    unique.map(async (url) => {
      try {
        const r = await withTimeout(runPreflight(url, { method, maxUsd, network }), timeoutMs);
        return { url, verdict: r.verdict, safe_to_pay: r.safe_to_pay, summary: r.summary, recommended_option: r.recommended_option, options: r.options, reasons: r.reasons, track_record: r.signals?.track_record ? { days_checked: r.signals.track_record.days_checked, payable_ratio: r.signals.track_record.payable_ratio } : null, cached: r.cached ?? false };
      } catch (err) {
        return { url, verdict: 'unknown', safe_to_pay: false, summary: `Could not check: ${err.message}`, error: err.message };
      }
    })
  );
  const counts = { go: 0, caution: 0, no_go: 0, unknown: 0 };
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  return { count: results.length, counts, results, checked_at: new Date().toISOString() };
}

// History string (aligned to the end of days[]) as one entry per scanned day.
function dailyHistory(track) {
  if (!track?.history) return [];
  const days = Array.isArray(track.days) ? track.days : [];
  const offset = days.length - track.history.length;
  return [...track.history]
    .map((c, i) => ({ date: days[offset + i] ?? null, status: c in STATUS ? STATUS[c] : 'unknown' }))
    .filter((d) => d.status !== null);
}

async function deepPreflight(url, { runPreflight, diagnose, trustIndex, method, maxUsd, network } = {}) {
  const [pre, report, track, seller] = await Promise.all([
    runPreflight(url, { method, maxUsd, network }),
    diagnose(url, method).catch((err) => ({ overall: null, checks: [], error: err.message })),
    trustIndex ? trustIndex.lookup(url, { waitMs: 3000 }).catch(() => null) : null,
    trustIndex?.seller ? trustIndex.seller(url, { waitMs: 3000 }).catch(() => null) : null,
  ]);
  const reasons = [...pre.reasons];
  if (seller && seller.resources >= 3 && seller.avg_payable_ratio < 0.5) {
    reasons.push({ level: 'caution', code: 'unreliable_seller', message: `This seller's ${seller.resources} scanned endpoints were payable on only ${Math.round(seller.avg_payable_ratio * 100)}% of the last daily scans.` });
  }
  const moved = (report.checks || []).filter((c) => (c.id === 'well-known' || c.id === 'bazaar-listing') && c.status !== 'pass');
  for (const c of moved) if (c.status === 'warn') reasons.push({ level: 'info', code: `domain_${c.id.replace('-', '_')}`, message: c.message });
  const verdict = reasons.some((r) => r.level === 'no_go') ? 'no_go' : reasons.some((r) => r.level === 'caution') ? 'caution' : 'go';
  const summary = verdict === pre.verdict ? pre.summary : `Payable, with caution: ${reasons.filter((r) => r.level === 'caution').map((r) => r.message).join(' ')}`;
  return {
    ...pre,
    verdict,
    safe_to_pay: verdict !== 'no_go',
    summary,
    reasons,
    diagnosis: { overall: report.overall ?? null, problems: (report.checks || []).filter((c) => c.status === 'fail' || c.status === 'warn'), checks: report.checks || [], error: report.error },
    history: dailyHistory(track),
    seller,
    domain: { checks: (report.checks || []).filter((c) => c.id === 'well-known' || c.id === 'bazaar-listing') },
  };
}

const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    count: { type: 'integer' },
    counts: { type: 'object', properties: { go: { type: 'integer' }, caution: { type: 'integer' }, no_go: { type: 'integer' }, unknown: { type: 'integer' } } },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          verdict: { type: 'string', enum: ['go', 'caution', 'no_go', 'unknown'] },
          safe_to_pay: { type: 'boolean' },
          summary: { type: 'string' },
          recommended_option: { type: ['integer', 'null'] },
          options: { type: 'array' },
          reasons: { type: 'array' },
          error: { type: 'string' },
        },
        required: ['url', 'verdict', 'safe_to_pay', 'summary'],
      },
    },
    checked_at: { type: 'string' },
  },
  required: ['count', 'counts', 'results'],
};

module.exports = { batchPreflight, deepPreflight, dailyHistory, BATCH_SCHEMA, BATCH_MAX };
