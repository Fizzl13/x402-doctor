'use strict';

// A longer history of the on-chain payment counts. The hourly files (payments*.json on the payments-data branch) keep
// today and the 7 days before it, which is what the preflight and /trust read; a comparison over another window (a
// researcher's week offset by a few hours, a month) needs the days before that. The collector hands every day that
// leaves an hourly file to archiveDropped(), which keeps it, as it was, in history/<same name> for HISTORY_DAYS days.
// Nothing at runtime reads the history: x402 Doctor's memory doesn't grow with it.

const HISTORY_DAYS = 35;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Every day a state file holds: its read days and the days any payout address has data for.
function daysOf(state) {
  const out = new Set(Object.keys(state?.days || {}));
  for (const entry of Object.values(state?.pay_tos || {})) for (const day of Object.keys(entry?.d || {})) out.add(day);
  return out;
}

// The history after one collector run: `before` is the hourly file as it was, `after` as it is now. Days in `before`
// that `after` no longer has are added, with their read days (coverage) and every payout address's data for them;
// days older than keepDays are dropped. The file's own fields (network, token, per_day, symbol) are kept so the same
// readers work on it.
function archiveDropped(before, after, archive, { keepDays = HISTORY_DAYS, now = Date.now } = {}) {
  const ref = after || before || {};
  const a = archive?.version === 1 && (archive.network || null) === (ref.network || null)
    ? JSON.parse(JSON.stringify(archive))
    : { version: 1, days: {}, pay_tos: {} };
  for (const key of ['network', 'symbol', 'token', 'tokens', 'per_day']) if (ref[key] !== undefined) a[key] = ref[key];
  a.keep_days = keepDays;

  if (before) {
    const kept = daysOf(after);
    const dropped = [...daysOf(before)].filter((day) => !kept.has(day));
    for (const day of dropped) if (before.days?.[day]) a.days[day] = before.days[day];
    for (const [addr, entry] of Object.entries(before.pay_tos || {})) {
      for (const day of dropped) {
        const d = entry?.d?.[day];
        if (!d) continue;
        const target = (a.pay_tos[addr] ||= { d: {} });
        if (entry.since && (!target.since || entry.since < target.since)) target.since = entry.since;
        target.d[day] = d;
      }
    }
  }

  const cutoff = dayOf(Date.parse(`${dayOf(now())}T00:00:00Z`) - keepDays * 86400000);
  for (const day of Object.keys(a.days)) if (day < cutoff) delete a.days[day];
  for (const [addr, entry] of Object.entries(a.pay_tos)) {
    for (const day of Object.keys(entry.d)) if (day < cutoff) delete entry.d[day];
    if (!Object.keys(entry.d).length) delete a.pay_tos[addr];
  }
  a.updated = new Date(now()).toISOString();
  return a;
}

module.exports = { HISTORY_DAYS, archiveDropped, daysOf };
