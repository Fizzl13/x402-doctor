// Starts Doctor's Monday workflows when GitHub has not. On 26 Oct and 2 Nov 2026 the scheduled dependency audit
// (audit.yml, 05:17 UTC) and the weekly report (weekly-report.yml, 06:43 UTC) had not started hours later and were
// started by hand. Every half hour on a Monday, after a workflow's time plus two hours, Doctor asks GitHub whether it
// has run since Monday 00:00 UTC (any event: a late schedule or a manual start counts) and starts it once if not.
// One start per workflow per week, so a failing workflow is not started over and over. Same token as the delivery
// check (Actions: read and write on this repository).

const API = 'https://api.github.com';
const WEEKLY = [
  { workflow: 'audit.yml', afterMinutes: 7 * 60 + 17 },
  { workflow: 'weekly-report.yml', afterMinutes: 8 * 60 + 43 },
];

function createWeeklyWatch({ token = null, repo = 'Fizzl13/x402-doctor', workflows = WEEKLY, dispatch, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
  const started = new Map(); // workflow -> the Monday (YYYY-MM-DD) it was started for
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'x402-doctor' };

  // Has the workflow run (or started) since that Monday? Unknown counts as yes: no start on a GitHub error.
  async function ranSince(workflow, monday) {
    try {
      const res = await fetchImpl(`${API}/repos/${repo}/actions/workflows/${workflow}/runs?created=%3E%3D${monday}&per_page=1`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return true;
      const body = await res.json();
      return Number(body.total_count) > 0;
    } catch {
      return true;
    }
  }

  // The workflows due now: Monday (UTC), past their time, not started by us this week.
  function due(at = now()) {
    const d = new Date(at);
    if (d.getUTCDay() !== 1) return [];
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    const monday = d.toISOString().slice(0, 10);
    return workflows.filter((w) => minutes >= w.afterMinutes && started.get(w.workflow) !== monday).map((w) => ({ ...w, monday }));
  }

  async function tick() {
    if (!token || typeof dispatch !== 'function') return [];
    const out = [];
    for (const w of due()) {
      if (await ranSince(w.workflow, w.monday)) { started.set(w.workflow, w.monday); continue; }
      started.set(w.workflow, w.monday);
      log.log(`[weekly] ${w.workflow} has not run since ${w.monday} 00:00 UTC; starting it`);
      if (await dispatch(w.workflow)) out.push(w.workflow);
    }
    return out;
  }

  return { due, tick };
}

module.exports = { createWeeklyWatch, WEEKLY };
