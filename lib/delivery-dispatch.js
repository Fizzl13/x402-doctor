// Starts the delivery-check workflow (.github/workflows/delivery-check.yml) as soon as an order is paid, instead of
// waiting for its schedule: GitHub runs scheduled workflows on this repository hours late, or drops them. The
// schedule stays as the fallback.
//
// Needs DELIVERY_DISPATCH_TOKEN in Render: a fine-grained GitHub token for Fizzl13/x402-doctor only, with the
// permission Actions: read and write. It can start workflows, nothing else; the wallet key stays in GitHub's secrets.
// Without it, orders wait for the schedule.

const API = 'https://api.github.com';

function createDispatcher({ token = null, repo = 'Fizzl13/x402-doctor', workflow = 'delivery-check.yml', ref = 'master', fetchImpl = globalThis.fetch, now = () => Date.now(), minGapMs = 60_000, log = console, waits = 'the order waits for the schedule' } = {}) {
  let last = 0;
  let pending = null;
  let check = { state: token ? 'checking' : 'off' };
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'x402-doctor' };

  // Does the token work? Reads the workflow (needs the same token, repository and Actions access as a start, and
  // starts nothing), so a wrong or expired token shows in /api/health before the first order instead of after it.
  async function verify() {
    if (!token) return check;
    const at = new Date(now()).toISOString();
    try {
      const res = await fetchImpl(`${API}/repos/${repo}/actions/workflows/${workflow}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (res.ok) check = { state: 'ok', checked_at: at };
      else {
        check = { state: 'failed', error: `HTTP ${res.status}`, checked_at: at };
        log.error(`[delivery] DELIVERY_DISPATCH_TOKEN does not work (HTTP ${res.status}): paid orders wait for the workflow schedule`);
      }
    } catch (err) {
      // GitHub not reachable says nothing about the token: keep the last result, note the error.
      check = { ...check, state: check.state === 'checking' ? 'unknown' : check.state, error: err.message, checked_at: at };
    }
    return check;
  }

  async function send() {
    pending = null;
    last = now();
    try {
      const res = await fetchImpl(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ref }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      log.error(`[delivery] could not start ${workflow} (${err.message}); ${waits}`);
      return false;
    }
  }

  return {
    enabled: Boolean(token),
    verify,
    status: () => check,
    // At most one start a minute: a run takes every queued job, so orders that come in together share one. A start
    // asked for within the minute is sent when it ends.
    dispatch() {
      if (!token) return Promise.resolve(false);
      if (pending) return pending;
      const wait = last + minGapMs - now();
      if (wait <= 0) return send();
      pending = new Promise((resolve) => { setTimeout(() => resolve(send()), wait); });
      return pending;
    },
  };
}

module.exports = { createDispatcher };
