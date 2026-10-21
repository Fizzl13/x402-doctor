// Starts the day's Trust Index scan (.github/workflows/trust-scan.yml) when GitHub has not. The schedule fires at
// 03:17, 09:17, 15:17 and 21:17 UTC and the first run that starts does the day, but GitHub drops scheduled runs when it
// is busy: on 21 Oct 2026 the 03:17 run never started, and Doctor served the day before until a run was started by
// hand at 07:31. From 04:15 UTC, every half hour, Doctor looks at the scan it serves; while that is not today's, it
// starts the workflow with only_if_missing, which stops at once when today's scan was published in the meantime
// (Doctor's copy can be 30 minutes old) and waits behind a scan that is still running (concurrency group trust-scan).
// At most one start per two hours, so a failing scan is not started over and over.

const DEFAULT_AFTER = 4 * 60 + 15; // minutes after midnight UTC
const DEFAULT_GAP_MS = 2 * 60 * 60 * 1000;

function createScanWatch({ dispatcher, trustIndex, now = () => Date.now(), log = console, afterMinutes = DEFAULT_AFTER, gapMs = DEFAULT_GAP_MS } = {}) {
  let last = 0;

  // Is today's scan missing from what Doctor serves? Unknown (nothing loaded yet) counts as no: a fresh start or a
  // failed download is not a reason to scan again.
  function missing(updated, at = now()) {
    const d = new Date(at);
    if (d.getUTCHours() * 60 + d.getUTCMinutes() < afterMinutes) return false;
    if (typeof updated !== 'string' || !/^\d{4}-\d\d-\d\d/.test(updated)) return false;
    return updated.slice(0, 10) < d.toISOString().slice(0, 10);
  }

  async function tick() {
    if (!dispatcher?.enabled) return false;
    const at = now();
    if (at - last < gapMs) return false;
    try { await trustIndex.refresh?.(); } catch { /* a failed check leaves the copy Doctor has */ }
    const updated = trustIndex.updated?.() ?? null;
    if (!missing(updated, at)) return false;
    last = at;
    log.log(`[trust-scan] today's scan is not published (Doctor serves ${updated}); starting trust-scan.yml`);
    return dispatcher.dispatch();
  }

  return { missing, tick };
}

module.exports = { createScanWatch };
