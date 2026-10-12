// The purchase side of the paid delivery check (lib/delivery-checks.js), run by scripts/delivery-check.js in
// .github/workflows/delivery-check.yml: which queued jobs to buy now, and what is published per purchase.
// The buying itself is the spot-buy's (lib/spot-buy.js runSpotBuy): fresh preflight with the payout screen, the
// seller's declared example input, the charge measured on chain.

const { CAP_USD, DAILY_MAX, isId } = require('./delivery-checks');

const USER_AGENT = 'x402-doctor-delivery-check/1.0 (+https://x402-doctor.fizzl.eu; a paid delivery check: one purchase that someone ordered)';
const PER_RUN = 5;
const OWN_HOST = /(^|\.)fizzl\.eu$/i;
// Stopped by the wallet, not by the endpoint: the job stays queued for the next run.
const RETRY = new Set(['wallet_empty']);

// The jobs to buy in this run: queued ones not done yet, oldest first, within the per-run and daily limits (the
// server enforces the daily limit too; this is the second line, should the queue ever hold more).
function jobsToRun(queue, index, { now = Date.now(), perRun = PER_RUN, dailyMax = DAILY_MAX } = {}) {
  const done = index?.results || {};
  const today = new Date(now).toISOString().slice(0, 10);
  const boughtToday = Object.values(done).filter((r) => String(r.date || '').startsWith(today) && r.step === 'paid').length;
  const room = Math.max(0, Math.min(perRun, dailyMax - boughtToday));
  return (queue?.jobs || [])
    .filter((j) => isId(j.id) && !done[j.id] && candidateOf(j))
    .sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)))
    .slice(0, room);
}

// A queued job as a spot-buy candidate; null for anything that is not one public https endpoint of someone else.
function candidateOf(job) {
  let u;
  try { u = new URL(job.url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || OWN_HOST.test(u.hostname)) return null;
  return { url: u.href, host: u.hostname.toLowerCase(), method: ['GET', 'POST'].includes(job.method) ? job.method : null, price_usd: null };
}

// What is published for one purchase: the outcome and its evidence, without wallet internals.
function recordOf(job, r, at = new Date().toISOString()) {
  return {
    id: job.id,
    url: job.url,
    queued_at: job.queued_at ?? null,
    date: at,
    result: r.result,
    step: r.step,
    paid_and_delivered: r.result === 'delivered' || r.result === 'off_schema',
    status: r.status ?? null,
    price_usd: r.price_usd ?? null,
    charged_usd: r.charged_usd ?? null,
    request: r.request ? { method: r.request.method, source: r.request.source } : null,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.preflight ? { preflight: r.preflight } : {}),
    transaction: r.proof?.transaction ?? null,
    explorer: r.proof?.explorer ?? null,
    cap_usd: CAP_USD,
  };
}

module.exports = { jobsToRun, candidateOf, recordOf, RETRY, USER_AGENT, PER_RUN };
