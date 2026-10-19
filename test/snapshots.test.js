// Week-over-week snapshots of the weekly digests (lib/snapshots.js): a second run on the same day's data compares
// with what the first run compared with, through the `before` each snapshot carries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { previousFor, withBefore } = require('../lib/snapshots');

test('previousFor: last week as published; on a rerun the snapshot that one was compared with', () => {
  const lastWeek = { date: '2026-10-12', all: ['a'] };
  assert.equal(previousFor(null, '2026-10-18'), null);
  assert.equal(previousFor(lastWeek, '2026-10-18'), lastWeek);
  const firstRun = withBefore({ date: '2026-10-18', all: ['a', 'b'] }, { ...lastWeek, before: { date: '2026-10-05' } });
  assert.deepEqual(firstRun.before, lastWeek, "the one compared with, without its own before");
  assert.deepEqual(previousFor(firstRun, '2026-10-18'), lastWeek, 'same day: compare with last week again');
  assert.equal(previousFor({ date: '2026-10-18' }, '2026-10-18'), null, 'an older snapshot without before: no comparison rather than itself');
  assert.deepEqual(withBefore({ date: '2026-10-18' }, null), { date: '2026-10-18', before: null });
});

test('network digest run twice on the same index: the second run still compares with last week', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshots-'));
  const ALGO = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
  const go = { verdict: 'go', codes: [], price_usd: 0.01, networks: [ALGO] };
  const index = { days: ['2026-10-12', '2026-10-18'], resources: { 'https://a.example/x': { url: 'https://a.example/x', h: 'gg', last: go }, 'https://b.example/y': { url: 'https://b.example/y', h: '-g', last: go } } };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  const prev = path.join(dir, 'prev');
  fs.mkdirSync(prev);
  fs.writeFileSync(path.join(prev, 'algorand-latest.json'), JSON.stringify({ network: 'algorand', date: '2026-10-12', all: ['https://a.example/x', 'https://gone.example/z'], payable: ['https://a.example/x', 'https://gone.example/z'], sites: ['a.example', 'gone.example'] }));
  const run = (out) => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'network-digest.js'), '--index', path.join(dir, 'index.json'), '--previous', prev, '--out', out], { encoding: 'utf8' });

  const first = run(path.join(dir, 'one'));
  assert.match(first, /algorand 2026-10-18: 2 payable endpoints from 2 sellers, 1 new, 1 stopped \(vs 2026-10-12\)/);
  // The first run's snapshot is what the second run finds as the latest one.
  fs.copyFileSync(path.join(dir, 'one', 'networks', 'algorand-latest.json'), path.join(prev, 'algorand-latest.json'));
  const second = run(path.join(dir, 'two'));
  assert.match(second, /algorand 2026-10-18: 2 payable endpoints from 2 sellers, 1 new, 1 stopped \(vs 2026-10-12\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'two', '2026-10-18-algorand-posts.md'), 'utf8'), fs.readFileSync(path.join(dir, 'one', '2026-10-18-algorand-posts.md'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'two', 'networks', 'algorand-latest.json'), 'utf8')).before.date, '2026-10-12');
  fs.rmSync(dir, { recursive: true, force: true });
});
