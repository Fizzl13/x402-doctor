// Weekly digest per payment network from the Trust Index (lib/network-digest.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { networkDigest } = require('../lib/network-digest');

const BASE = 'eip155:8453';
const ALGO = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const XRPL = 'xrpl:0';
const days = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'];
const res = (url, h, last, p) => [url, { url, h, last, ...(p ? { p } : {}) }];
const go = (price, networks) => ({ verdict: 'go', codes: [], price_usd: price, networks });

const index = {
  days,
  resources: Object.fromEntries([
    res('https://api.big.example/one', 'gggggggg', go(0.01, [ALGO, BASE])),
    res('https://pay.big.example/two', 'gggggggg', go(0.03, [ALGO])),
    res('https://small.example/x', '-------g', go(0.02, [ALGO, XRPL])),
    res('https://broken.example/y', 'gggggggc', { verdict: 'go', codes: [], price_usd: 0.01, networks: [BASE], unpayable: { [ALGO]: 'accepts[1]: payTo is not a valid Algorand address; fix it' } }),
    res('https://gone.example/z', 'ggggg---', go(0.01, [ALGO])),
    res('https://base-only.example/b', 'gggggggg', go(0.01, [BASE])),
    res('https://mpp.example/m', 'gggggggg', go(0.01, [ALGO]), 'mpp'),
  ]),
};

test('counts what accepts the network today, names payable sellers only, counts problems', () => {
  const { stats } = networkDigest(index, 'algorand');
  assert.equal(stats.date, '2026-09-29');
  assert.equal(stats.endpoints, 4, 'not seen today, MPP and other networks are left out');
  assert.equal(stats.payable, 3);
  assert.equal(stats.payable_sellers, 2, 'api.big.example and pay.big.example are one seller');
  assert.equal(stats.only_here, 1);
  assert.equal(stats.also_base_pct, 33.3);
  assert.equal(stats.median_price_usd, 0.02);
  assert.equal(stats.added, 1, 'without a snapshot: first seen this week');
  assert.equal(stats.stopped, null);
  assert.deepEqual(stats.top_sellers, [{ host: 'big.example', endpoints: 2 }, { host: 'small.example', endpoints: 1 }]);
  assert.deepEqual(stats.problems, [{ problem: 'payTo is not a valid Algorand address', count: 1 }]);
});

test('compares with last week: new endpoints, stopped ones and new sellers', () => {
  const previous = { network: 'algorand', date: '2026-09-22', all: ['https://api.big.example/one', 'https://gone.example/z'], payable: ['https://api.big.example/one', 'https://gone.example/z'], sites: ['big.example', 'gone.example'] };
  const { stats, snapshot } = networkDigest(index, 'algorand', previous);
  assert.equal(stats.since, '2026-09-22');
  assert.equal(stats.added, 3);
  assert.equal(stats.stopped, 1);
  assert.deepEqual(stats.new_sellers, [{ host: 'small.example', endpoints: 1 }]);
  assert.deepEqual(snapshot.payable, ['https://api.big.example/one', 'https://pay.big.example/two', 'https://small.example/x']);
  assert.deepEqual(snapshot.sites, ['big.example', 'small.example']);
  // A snapshot of another network is ignored.
  assert.equal(networkDigest(index, 'algorand', { ...previous, network: 'xrpl' }).stats.stopped, null);
});

test('drafts: the X post fits 280 characters, the broken seller is never named', () => {
  const previous = { network: 'algorand', date: '2026-09-22', all: [], payable: ['https://gone.example/z'], sites: [] };
  const d = networkDigest(index, 'algorand', previous);
  assert.ok(d.posts.x_length <= 280);
  assert.match(d.posts.x, /3 paid APIs from 2 sellers accept Algorand/);
  assert.match(d.posts.x, /x402-doctor\.fizzl\.eu\/algorand #Algorand/);
  for (const text of [d.markdown, d.posts.x, d.posts.community]) {
    assert.doesNotMatch(text, /broken\.example|gone\.example/);
  }
  assert.match(d.markdown, /1 more list it but can't be paid there/);
  assert.match(d.markdown, /Since 2026-09-22: \*\*4\*\* new endpoints, \*\*1\*\* stopped being payable, new sellers: big\.example and small\.example/);
});

test('the XRP Ledger: one endpoint, every one also on another network', () => {
  const d = networkDigest(index, 'xrpl');
  assert.equal(d.stats.payable, 1);
  assert.match(d.markdown, /# x402 on the XRP Ledger/);
  assert.match(d.markdown, /All of them accept other networks too/);
  assert.throws(() => networkDigest(index, 'nope'), /unknown network family/);
});

test('loads without any npm package (the weekly workflow runs without npm ci)', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', "require('./lib/network-digest'); require('./lib/weekly-report'); console.log(Object.keys(require.cache).filter((f) => f.includes('node_modules')).length)"], { cwd: require('node:path').join(__dirname, '..') });
  assert.equal(String(out).trim(), '0');
});
