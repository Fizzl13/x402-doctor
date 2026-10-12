// Starts the delivery-check workflow (.github/workflows/delivery-check.yml) as soon as an order is paid, instead of
// waiting for its schedule: GitHub runs scheduled workflows on this repository hours late, or drops them. The
// schedule stays as the fallback.
//
// Needs DELIVERY_DISPATCH_TOKEN in Render: a fine-grained GitHub token for Fizzl13/x402-doctor only, with the
// permission Actions: read and write. It can start workflows, nothing else; the wallet key stays in GitHub's secrets.
// Without it, orders wait for the schedule.

const API = 'https://api.github.com';

function createDispatcher({ token = null, repo = 'Fizzl13/x402-doctor', workflow = 'delivery-check.yml', ref = 'master', fetchImpl = globalThis.fetch, now = () => Date.now(), minGapMs = 60_000, log = console } = {}) {
  let last = 0;
  let pending = null;

  async function send() {
    pending = null;
    last = now();
    try {
      const res = await fetchImpl(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', 'user-agent': 'x402-doctor' },
        body: JSON.stringify({ ref }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      log.error(`[delivery] could not start the workflow (${err.message}); the order waits for the schedule`);
      return false;
    }
  }

  return {
    enabled: Boolean(token),
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
