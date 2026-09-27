// MetaMask's site scanner verdict, against a fake scanner (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSiteScan, _clearCache } = require('../lib/site-scan');

const scanner = (body, status = 200) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
};

test('a blocked domain warns, names the risk and how to report it', async () => {
  _clearCache();
  const { fetchImpl, calls } = scanner({ domainName: 'api.example.com', recommendedAction: 'BLOCK', riskFactors: [{ type: 'DRAINER', severity: 'CRITICAL', message: 'Domain identified as a wallet drainer.' }] });
  const checks = [];
  await checkSiteScan('https://api.example.com/paid', checks, { fetchImpl });
  assert.equal(calls[0], 'https://dapp-scanning.api.cx.metamask.io/scan?url=https%3A%2F%2Fapi.example.com');
  assert.equal(checks[0].id, 'metamask-site-scan');
  assert.equal(checks[0].status, 'warn');
  assert.match(checks[0].message, /MetaMask blocks api\.example\.com.*DRAINER \(critical\): Domain identified as a wallet drainer\. MetaMask users/);
  assert.match(checks[0].hint, /false positive/);
});

test('no warning passes; results are cached per host', async () => {
  _clearCache();
  const { fetchImpl, calls } = scanner({ recommendedAction: 'NONE', riskFactors: null });
  const checks = [];
  await checkSiteScan('https://ok.example.com/a', checks, { fetchImpl });
  await checkSiteScan('https://ok.example.com/b', checks, { fetchImpl });
  assert.deepEqual(checks.map((c) => c.status), ['pass', 'pass']);
  assert.equal(calls.length, 1);
});

test('other actions warn; scanner errors are info; local hosts are skipped', async () => {
  _clearCache();
  let checks = [];
  await checkSiteScan('https://w.example.com/', checks, scanner({ recommendedAction: 'WARN', riskFactors: [{ type: 'PHISHING', severity: 'MEDIUM' }] }));
  assert.equal(checks[0].status, 'warn');
  assert.match(checks[0].message, /"WARN".*PHISHING \(medium\)/);
  checks = [];
  await checkSiteScan('https://e.example.com/', checks, scanner({}, 500));
  assert.equal(checks[0].status, 'info');
  checks = [];
  await checkSiteScan('http://127.0.0.1:4000/x', checks, scanner({ recommendedAction: 'BLOCK' }));
  assert.equal(checks.length, 0);
});

test('diagnose() leaves the MetaMask scanner off unless METAMASK_SCAN=on', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../lib/diagnose.js'), 'utf8');
  assert.match(src, /siteScan = process\.env\.METAMASK_SCAN === 'on'/);
});
