// The week-over-week snapshots of the weekly digests (reports/networks/<network>-latest.json and
// reports/market/market-latest.json on the weekly-reports branch). A digest run again on the same data (a second run
// the same day) must not compare with the snapshot the first run just wrote: each snapshot carries the one it was
// compared with as `before`, and a rerun compares with that instead.

// The snapshot to compare with for a digest of `date`, given the latest published one.
function previousFor(latest, date) {
  if (!latest) return null;
  if (latest.date && date && latest.date >= date) return latest.before ?? null;
  return latest;
}

// The snapshot to publish: this run's, with the one it was compared with (without that one's own `before`).
function withBefore(snapshot, previous) {
  if (!previous) return { ...snapshot, before: null };
  const { before: _ignored, ...rest } = previous;
  return { ...snapshot, before: rest };
}

module.exports = { previousFor, withBefore };
