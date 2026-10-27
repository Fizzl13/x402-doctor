// The Trust Index as a Hugging Face dataset (scripts/hf-export.js): one row per endpoint in today's scan with its
// category and track record, go / caution / no_go per day, and a dataset card whose counts match the rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { endpointRows, dailyRows, spotRows, paymentRows, card } = require('../scripts/hf-export');
const { descKey } = require('../lib/services');

const index = {
  version: 1,
  updated: '2026-10-18T03:40:00Z',
  days: ['2026-10-16', '2026-10-17', '2026-10-18'],
  resources: {
    'https://a.example/price': { url: 'https://a.example/price', m: 'GET', h: 'ggc', d: 'Bitcoin price feed', last: { verdict: 'caution', codes: ['no_bazaar_extension'], price_usd: 0.01, networks: ['eip155:8453', 'stellar:pubnet'], ms: 120 } },
    'https://b.example/mpp': { url: 'https://b.example/mpp', m: 'POST', p: 'mpp', h: '-gn', d: 'Weather forecast', last: { verdict: 'no_go', codes: ['no_402'], price_usd: null, networks: [], ms: 80, unpayable: { 'stellar:pubnet': 'asset given as text' } }, probe: 'https://b.example/mpp/x' },
    'https://c.example/gone': { url: 'https://c.example/gone', m: 'GET', h: 'gg-', d: 'Delisted', last: { verdict: 'go', codes: [], price_usd: 0.001, networks: ['eip155:8453'], ms: 50 } },
  },
  sanctions: { list: 'OFAC SDN', published: '2026-10-15', addresses: 1200 },
};
const categories = { [descKey('Bitcoin price feed')]: 'finance' };

test('one row per endpoint in today\'s scan, with category and track record', () => {
  const rows = endpointRows(index, categories);
  assert.deepEqual(rows.map((r) => r.url), ['https://a.example/price', 'https://b.example/mpp']);
  const [a, b] = rows;
  assert.equal(a.host, 'a.example');
  assert.equal(a.protocol, 'x402');
  assert.equal(a.verdict, 'caution');
  assert.deepEqual(a.networks, ['eip155:8453', 'stellar:pubnet']);
  assert.equal(a.category, 'finance', 'Jev\'s category wins');
  assert.equal(a.same_service_endpoints, 1);
  assert.deepEqual([a.days_checked, a.days_payable, a.payable_ratio], [3, 3, 1]);
  assert.equal(b.protocol, 'mpp');
  assert.equal(b.method, 'POST');
  assert.deepEqual(b.unpayable_networks, ['stellar:pubnet']);
  assert.equal(b.category, 'places', 'keyword guess without Jev');
  assert.deepEqual([b.days_checked, b.days_payable, b.payable_ratio], [2, 1, 0.5]);
  assert.equal('probe' in b, false, 'only the published fields');
});

test('go / caution / no_go per day from the histories', () => {
  assert.deepEqual(dailyRows(index), [
    { date: '2026-10-16', go: 2, caution: 0, no_go: 0, checked: 2 },
    { date: '2026-10-17', go: 3, caution: 0, no_go: 0, checked: 3 },
    { date: '2026-10-18', go: 0, caution: 1, no_go: 1, checked: 2 },
  ]);
});

test('the dataset card states today\'s counts and both configs', () => {
  const md = card({ date: '2026-10-18', rows: endpointRows(index, categories), daily: dailyRows(index), sanctions: index.sanctions });
  assert.match(md, /^---\nlicense: cc-by-4\.0\n/);
  assert.match(md, /config_name: endpoints\n  data_files: data\/endpoints\.jsonl/);
  assert.match(md, /config_name: daily\n  data_files: data\/daily\.csv/);
  assert.match(md, /Scan of \*\*2026-10-18\*\*: 2 endpoints, 1 \(50%\) payable as listed\. Daily history since 2026-10-16\./);
  assert.match(md, /OFAC SDN list, published 2026-10-15/);
});

test('the script writes the three files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-export-'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, 'categories.json'), JSON.stringify({ categories }));
  const out = path.join(dir, 'hf');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'hf-export.js'), '--index', path.join(dir, 'index.json'), '--categories', path.join(dir, 'categories.json'), '--out', out], { env: { ...process.env, HF_DATASET: 'someone/x402-trust-index' } });
  const lines = fs.readFileSync(path.join(out, 'data', 'endpoints.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(fs.readFileSync(path.join(out, 'data', 'daily.csv'), 'utf8'), 'date,go,caution,no_go,checked\n2026-10-16,2,0,0,2\n2026-10-17,3,0,0,3\n2026-10-18,0,1,1,2\n');
  assert.match(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), /load_dataset\("someone\/x402-trust-index", "endpoints"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spot-buy purchases and on-chain payments become their own files and configs, only when there is data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-spot-'));
  const report = (date, live) => ({ date, summary: { live }, results: [
    { url: 'https://a.example/price', host: 'a.example', step: 'paid', result: 'delivered', price_usd: 0.01, charged_usd: 0.01, status: 200, ms: 4400, request: { source: 'example' } },
    { url: 'https://b.example/x', host: 'b.example', step: 'paid', result: 'charged_not_delivered', price_usd: 0.05, charged_usd: 0.05, status: null, ms: 90000, timed_out: true, request: { source: 'example' } },
    { url: 'https://c.example/y', host: 'c.example', step: 'skipped', result: 'not_go_now' },
  ] });
  fs.writeFileSync(path.join(dir, '2026-10-18.json'), JSON.stringify(report('2026-10-18', true)));
  fs.writeFileSync(path.join(dir, '2026-10-18-2.json'), JSON.stringify(report('2026-10-18', true)));
  fs.writeFileSync(path.join(dir, '2026-10-11.json'), JSON.stringify(report('2026-10-11', false))); // a dry run
  const spot = spotRows(dir);
  assert.deepEqual(spot.map((r) => [r.run, r.host, r.result, r.answer_s, r.timed_out]), [
    ['2026-10-18-2', 'a.example', 'delivered', 4.4, false], ['2026-10-18-2', 'b.example', 'charged_not_delivered', 90, true],
    ['2026-10-18', 'a.example', 'delivered', 4.4, false], ['2026-10-18', 'b.example', 'charged_not_delivered', 90, true],
  ]);
  assert.deepEqual(spotRows(path.join(dir, 'missing')), []);

  const state = { version: 1, days: { '2026-10-18': { covered: 43200 }, '2026-10-19': { covered: 4320 } }, pay_tos: { '0x11': { since: '2026-10-18', d: { '2026-10-18': [3, 30000, ['aa', 'bb']], '2026-10-19': [1, 10000, ['aa']] } } } };
  assert.deepEqual(paymentRows(state), [
    { date: '2026-10-18', pay_to: '0x11', payments: 3, usd: 0.03, payers: 2, day_coverage: 1, network: 'eip155:8453' },
    { date: '2026-10-19', pay_to: '0x11', payments: 1, usd: 0.01, payers: 1, day_coverage: 0.1, network: 'eip155:8453' },
  ]);
  assert.deepEqual(paymentRows(null), []);
  // The other networks' files: a day marked read (per_day 1) is fully covered; their network comes from the file.
  const stellar = { version: 1, network: 'stellar:pubnet', per_day: 1, days: { '2026-10-18': { covered: 1 } }, pay_tos: { GABC: { since: '2026-10-18', d: { '2026-10-18': [2, 7000, ['GX']], '2026-10-19': [0, 0, [], { GY: 5 }] } } } };
  assert.deepEqual(paymentRows(state, null, stellar).filter((r) => r.date === '2026-10-18').map((r) => [r.network, r.pay_to, r.payments, r.usd, r.day_coverage]), [
    ['eip155:8453', '0x11', 3, 0.03, 1], ['stellar:pubnet', 'GABC', 2, 0.01, 1],
  ]);
  assert.equal(paymentRows(stellar).length, 1, 'a day with only USDC sent out is no row');

  const rows = endpointRows(index, categories);
  const md = card({ date: '2026-10-18', rows, daily: dailyRows(index), sanctions: index.sanctions, spot, payments: paymentRows(state) });
  assert.match(md, /config_name: spot_buys\n  data_files: data\/spot_buys\.jsonl/);
  assert.match(md, /config_name: onchain_payments\n  data_files: data\/onchain_payments\.csv/);
  assert.match(md, /4 purchases so far/);
  const plain = card({ date: '2026-10-18', rows, daily: dailyRows(index), sanctions: index.sanctions });
  assert.doesNotMatch(plain, /spot_buys|onchain_payments/);
  fs.rmSync(dir, { recursive: true, force: true });
});
