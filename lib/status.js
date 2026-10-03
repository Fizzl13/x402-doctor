// Public status page for the Fizzl services (/status, /api/status, and status.fizzl.eu when that
// domain points here): is each service up right now, and how reliable was it over the scanned days.
//
// Now: a live probe (homepage answers, paid route answers 402), at most every PROBE_MS, run when
// someone looks. History: the daily x402 Trust Index (one letter per day per resource); a service
// counts as up on a day when any of its tracked resources was payable (on fizzl.eu or on its old
// onrender.com address, which it moved from). Read-only: probes never pay.

const SERVICES = [
  {
    id: 'presign', name: 'presign-guard', what: 'Is this transaction safe to sign? Checks for agents before they pay.',
    home: 'https://presign-guard.fizzl.eu/',
    paid: { url: 'https://presign-guard.fizzl.eu/v1/token?chain=base&address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    track: ['https://presign-guard.fizzl.eu/v1/token', 'https://presign-guard.fizzl.eu/v1/check', 'https://presign-guard.onrender.com/v1/token', 'https://presign-guard.onrender.com/v1/check'],
  },
  {
    id: 'doctor', name: 'x402 Doctor', what: 'Diagnoses x402 endpoints and checks them before an agent pays.',
    home: 'https://x402-doctor.fizzl.eu/',
    paid: { url: 'https://x402-doctor.fizzl.eu/api/v1/diagnose?url=https://example.com' },
    track: ['https://x402-doctor.fizzl.eu/api/v1/diagnose', 'https://x402-doctor.fizzl.eu/api/v1/preflight', 'https://x402-doctor.onrender.com/api/v1/diagnose', 'https://x402-doctor.onrender.com/api/v1/preflight'],
  },
  {
    id: 'ichimoku', name: 'Ichimoku Signal', what: 'Crypto trend signals and trade setups, paid per call.',
    home: 'https://ichimoku-signal.fizzl.eu/',
    paid: { url: 'https://ichimoku-signal.fizzl.eu/signal/BTC-USDT' },
    track: ['https://ichimoku-signal.fizzl.eu/signal/:pair', 'https://ichimoku-signal.fizzl.eu/signals/:pair', 'https://ichimoku-signal.onrender.com/signal/:pair', 'https://ichimoku-signal.onrender.com/signals/:pair'],
  },
  {
    id: 'plaintext', name: 'PlainText', what: 'Smart contracts and wallets explained in plain words.',
    home: 'https://plaintext.fizzl.eu/',
    paid: { url: 'https://plaintext.fizzl.eu/api/check-wallet', method: 'POST' },
    track: ['https://plaintext.fizzl.eu/api/explain', 'https://plaintext.fizzl.eu/api/check-wallet', 'https://smartcontractexplainer.onrender.com/api/explain', 'https://smartcontractexplainer.onrender.com/api/check-wallet'],
  },
  {
    id: 'wallet', name: 'Fizzl Agent Wallet', what: 'Spending limits and approvals for AI agents.',
    home: 'https://wallet.fizzl.eu/',
    health: 'https://wallet.fizzl.eu/health',
    track: [],
  },
];
const PROBE_MS = 3 * 60 * 1000;
const SLOW_MS = 5000;
const UA = 'fizzl-status-monitor/1.0 (+https://x402-doctor.fizzl.eu/status)';
const UP = new Set(['g', 'c']);

function createStatus({ trustIndex, fetchImpl = globalThis.fetch, now = () => Date.now(), services = SERVICES } = {}) {
  let live = { at: 0, results: null };
  let probing = null;

  async function hit(url, method = 'GET') {
    const t = now();
    try {
      const res = await fetchImpl(url, { method, redirect: 'manual', headers: { 'user-agent': UA, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(20_000) });
      res.body?.cancel?.().catch?.(() => {});
      return { status: res.status, ms: now() - t };
    } catch (err) {
      return { status: 0, ms: now() - t, error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }

  async function probe(s) {
    const home = await hit(s.health || s.home);
    const paid = s.paid ? await hit(s.paid.url, s.paid.method) : null;
    const homeOk = home.status >= 200 && home.status < 400;
    const paidOk = !paid || paid.status === 402;
    const ms = Math.max(home.ms, paid ? paid.ms : 0);
    let state = 'up', note = s.paid ? 'Answers, and asks for payment (402) as it should.' : 'Answers.';
    if (!homeOk && (!paid || paid.status === 0 || paid.status >= 500)) { state = 'down'; note = home.error ? `Not reachable (${home.error}).` : `Answers with HTTP ${home.status}.`; }
    else if (!paidOk) { state = 'degraded'; note = paid.status === 0 ? `The paid route is not reachable (${paid.error}).` : `The paid route answers HTTP ${paid.status} instead of 402.`; }
    else if (!homeOk) { state = 'degraded'; note = `The home page answers HTTP ${home.status}; the paid route works.`; }
    else if (ms > SLOW_MS) { state = 'degraded'; note = `Slow: ${Math.round(ms / 100) / 10} s.`; }
    return { state, note, ms, home: home.status, paid: paid ? paid.status : undefined };
  }

  async function liveResults() {
    if (live.results && now() - live.at < PROBE_MS) return live;
    if (!probing) {
      probing = Promise.all(services.map(probe))
        .then((results) => { live = { at: now(), results }; })
        .finally(() => { probing = null; });
    }
    await probing;
    return live;
  }

  // Per scanned day: up when any tracked resource was payable, down when all scanned ones were not.
  async function history(s) {
    if (!s.track.length || !trustIndex) return null;
    const records = (await Promise.all(s.track.map((u) => trustIndex.lookup(u, { waitMs: 5000 }).catch(() => null)))).filter(Boolean);
    if (!records.length) return null;
    const days = records[0].days || [];
    const out = days.map((date) => ({ date, state: 'none' }));
    for (const r of records) {
      const h = r.history || '';
      const offset = days.length - h.length; // aligned to the end of days[]
      for (let i = 0; i < h.length; i++) {
        const d = out[offset + i];
        if (!d || h[i] === '-') continue;
        if (UP.has(h[i])) d.state = 'up';
        else if (d.state !== 'up') d.state = 'down';
      }
    }
    const checked = out.filter((d) => d.state !== 'none');
    const up = checked.filter((d) => d.state === 'up').length;
    return { days: out, checked: checked.length, up, uptime: checked.length ? Math.round((up / checked.length) * 1000) / 10 : null };
  }

  async function snapshot() {
    const [{ at, results }, histories] = await Promise.all([liveResults(), Promise.all(services.map(history))]);
    const list = services.map((s, i) => ({ id: s.id, name: s.name, what: s.what, url: s.home, now: results[i], history: histories[i] }));
    const states = list.map((s) => s.now.state);
    return {
      overall: states.includes('down') ? 'down' : states.includes('degraded') ? 'degraded' : 'up',
      checked_at: new Date(at).toISOString(),
      next_check_after: new Date(at + PROBE_MS).toISOString(),
      history_source: 'x402 Trust Index (daily scan of the CDP Bazaar), https://x402-doctor.fizzl.eu/trust',
      services: list,
    };
  }

  return { snapshot };
}

module.exports = { createStatus, SERVICES };
