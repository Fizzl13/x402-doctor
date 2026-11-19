// NEAR Builders Activity (activity.nearbuilders.org): a public, signed record of what people do across NEAR, scored
// on leaderboards. Doctor reports one thing there, the only action where it knows the user's NEAR account: a USDC
// payment on NEAR settled through its facilitator (lib/facilitator-service.js).
//   payment.settled   actor: the buyer (the signer of the delegate)
//   payment.received  actor: the seller's payTo
// The payload holds only what the chain already shows (transaction, amount); events are public and permanent.
//
// Off unless ACTIVITY_API_KEY is set (the Source API Key, a server-side secret: never logged). A report never holds
// up or breaks the settle: it runs after the answer, retries a 503 or a network error twice with the same body
// (the idempotency key makes a retry safe), and otherwise logs one line.
'use strict';

const ACTIVITY_URL = 'https://activity.nearbuilders.org/api/v1/events';
// Activity's own pattern for an actor (a NEAR account id).
const ACTOR = /^(?=.{2,64}$)([a-z0-9]+(?:[-_][a-z0-9]+)*)(\.([a-z0-9]+(?:[-_][a-z0-9]+)*))*$/;
const RETRY_MS = [2000, 10000];

function createActivityReporter({ env = process.env, fetchImpl = globalThis.fetch, log = console, url = ACTIVITY_URL, retryMs = RETRY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) } = {}) {
  const key = (env.ACTIVITY_API_KEY || '').trim();
  const stats = { sent: 0, failed: 0 };

  async function send(event) {
    const body = JSON.stringify({ payload: {}, ...event });
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let detail = '';
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'x402-doctor' },
          body,
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) { stats.sent++; return (await res.json().catch(() => ({}))).eventId || null; }
        status = res.status;
        detail = (await res.text().catch(() => '')).slice(0, 200);
        if (status === 409) { stats.sent++; return null; } // already reported with this key
      } catch (err) { detail = err.message; }
      if ((status === 0 || status === 503) && attempt < retryMs.length) { await sleep(retryMs[attempt]); continue; }
      stats.failed++;
      log.error(`[activity] ${event.eventType} for ${event.actor} not reported: ${status || 'network'} ${detail}`);
      return null;
    }
  }

  // A settled USDC payment on NEAR: the buyer paid, the seller received. Returns the reports' promise (tests wait on
  // it; the facilitator does not).
  function nearPaymentSettled({ payer, payTo, transaction, amount, asset, network }) {
    if (!key || !transaction) return Promise.resolve([]);
    const payload = { network, transaction, asset, amount: String(amount ?? '') };
    const events = [];
    if (ACTOR.test(String(payer))) events.push({ eventType: 'payment.settled', actor: payer, idempotencyKey: `${network}:${transaction}:settled`, payload });
    if (ACTOR.test(String(payTo)) && payTo !== payer) events.push({ eventType: 'payment.received', actor: payTo, idempotencyKey: `${network}:${transaction}:received`, payload });
    return (async () => { const ids = []; for (const e of events) ids.push(await send(e)); return ids; })(); // one after the other
  }

  return { enabled: Boolean(key), nearPaymentSettled, stats: () => ({ enabled: Boolean(key), ...stats }) };
}

module.exports = { createActivityReporter, ACTIVITY_URL };
