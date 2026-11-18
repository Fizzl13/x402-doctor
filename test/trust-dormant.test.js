// Dormant sellers (lib/trust-index.js dormantSites): a seller the scan could no longer reach stays in the index but
// leaves the summary's total and the atlas.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrustIndex, dormantSites, QUIET_DAYS } = require('../lib/trust-index');

const pad = (recent, older = 'g') => older.repeat(30 - recent.length) + recent; // 30 days, the last ones as given
const quiet = '-'.repeat(QUIET_DAYS);

const byName = {
  // Down: payable a month ago, nothing in the last 14 days but one failed try.
  d1: { url: 'https://market.down.example/x402/a', h: pad(quiet), last: { verdict: 'go' } },
  d2: { url: 'https://market.down.example/x402/b', h: pad('-'.repeat(QUIET_DAYS - 1) + 'x'), last: { verdict: 'error' } },
  d3: { url: 'https://market.down.example/x402/c', h: pad(quiet), last: { verdict: 'go' } },
  // Alive: payable yesterday.
  a1: { url: 'https://api.alive.example/a', h: pad('-'.repeat(QUIET_DAYS - 1) + 'g'), last: { verdict: 'go' } },
  a2: { url: 'https://api.alive.example/b', h: pad(quiet), last: { verdict: 'go' } },
  // Broken but answering every day: no_go, not dormant.
  b1: { url: 'https://broken.example/a', h: pad('n'.repeat(QUIET_DAYS), 'n'), last: { verdict: 'no_go', codes: ['no_402'] } },
  // New in the index: not dormant yet.
  n1: { url: 'https://new.example/a', h: '----', last: { verdict: 'not_checked' } },
  // Endpoints that need input: '-' by design.
  i1: { url: 'https://input.example/a', h: pad(quiet), last: { verdict: 'needs_input' } },
};

const resources = Object.fromEntries(Object.values(byName).map((r) => [r.url, r])); // the index is keyed by URL

test('dormantSites: no payable endpoint and under half checked in the window, never a young, answering or input-needing seller', () => {
  const d = dormantSites(resources);
  assert.deepEqual([...d], [['down.example', 3]]);
  assert.deepEqual([...dormantSites(resources, { quietDays: 40 })], [], 'a window longer than the history: every seller is young');
});

test('summary and atlas leave dormant sellers out, and say how many', async () => {
  const index = { updated: '2026-11-18T05:00:00Z', days: Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`), resources };
  const fetchImpl = async (url) => new Response(JSON.stringify(String(url).includes('cat') ? { categories: {}, bait: {} } : index));
  const ti = createTrustIndex({ url: 'http://index.test', categoriesUrl: 'http://cat.test', fetchImpl });
  await ti.refresh();
  const s = ti.summary();
  assert.equal(s.resources_all, 8);
  assert.equal(s.resources, 5);
  assert.deepEqual(s.dormant, { quiet_days: QUIET_DAYS, sellers: 1, endpoints: 3 });
  const a = ti.atlas();
  assert.ok(!a.sellers.some((x) => x[0] === 'down.example'), 'off the map');
  assert.ok(a.sellers.some((x) => x[0] === 'alive.example') && a.sellers.some((x) => x[0] === 'broken.example'));
  assert.deepEqual(a.dormant, { quiet_days: QUIET_DAYS, sellers: 1, endpoints: 3 });
  assert.ok((await ti.lookup('https://market.down.example/x402/a')), 'still in the index for a lookup');
});
