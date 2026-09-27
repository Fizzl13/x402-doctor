const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { overallOf, markdownSummary, annotations, parseUrls, exitCodeFor } = require('../lib/action-report');
const { main } = require('../bin/action');

const report = (overall, checks) => ({ url: 'https://api.example.com/paid', method: 'POST', overall, checks });
const failing = report('fail', [
  { id: 'returns-402', status: 'pass', group: 'protocol', message: 'Endpoint returns 402.' },
  { id: 'accepts[0]-payto', status: 'fail', group: 'payment', message: 'payTo is not an address | really', hint: 'Use your wallet\naddress.' },
  { id: 'bazaar', status: 'warn', group: 'discovery', message: 'No Bazaar extension.' },
  { id: 'paywall', status: 'info', group: 'browser', message: 'No paywall.' },
]);

test('action: URLs one per line or comma separated, comments and blanks skipped', () => {
  assert.deepEqual(parseUrls('https://a.example/x\n\n# staging\nhttps://b.example/y, https://c.example/z\n'), ['https://a.example/x', 'https://b.example/y', 'https://c.example/z']);
  assert.deepEqual(parseUrls(''), []);
});

test('action: the worst result wins, an URL that could not be checked is a fail', () => {
  assert.equal(overallOf([{ report: report('pass', []) }, { report: report('warn', []) }]), 'warn');
  assert.equal(overallOf([{ report: report('pass', []) }, { url: 'x', error: 'timeout' }]), 'fail');
  assert.equal(overallOf([]), 'pass');
});

test('action: fail-on decides the exit code', () => {
  assert.equal(exitCodeFor('fail', 'fail'), 1);
  assert.equal(exitCodeFor('warn', 'fail'), 0);
  assert.equal(exitCodeFor('warn', 'warn'), 1);
  assert.equal(exitCodeFor('pass', 'warn'), 0);
  assert.equal(exitCodeFor('fail', 'never'), 0);
});

test('action: the summary lists problems with fixes in a table that pipes and newlines cannot break', () => {
  const md = markdownSummary([{ url: failing.url, report: failing }, { url: 'https://down.example/', error: 'fetch failed' }]);
  assert.match(md, /^## x402 Doctor: ❌ fail/);
  assert.match(md, /### ❌ https:\/\/api\.example\.com\/paid \(POST\)/);
  assert.match(md, /1 passed · 1 warnings · 1 failed/);
  assert.match(md, /\| ❌ \| `accepts\[0\]-payto` \| payTo is not an address \\\| really \| Use your wallet address\. \|/);
  assert.match(md, /\| ⚠️ \| `bazaar` \|/);
  assert.match(md, /<details><summary>Passed checks and notes<\/summary>[\s\S]*Endpoint returns 402\.[\s\S]*No paywall\./);
  assert.match(md, /### ❌ https:\/\/down\.example\/\n\nCould not run the checks: fetch failed/);
});

test('action: annotations are errors for fails, warnings for warns, with escaped data', () => {
  const lines = annotations([{ url: failing.url, report: failing }]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^::error title=x402 Doctor accepts\[0\]-payto%3A https%3A\/\/api\.example\.com\/paid::payTo is not an address \| really Fix: Use your wallet%0Aaddress\.$/);
  assert.match(lines[1], /^::warning title=/);
});

test('action: end to end against a local endpoint, writes summary and outputs, exit code from fail-on', async () => {
  const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: 'not-an-address', payTo: 'nope', amount: '10000', maxTimeoutSeconds: 60 }] };
  const server = http.createServer((req, res) => {
    res.statusCode = 402;
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'));
    res.end(JSON.stringify(challenge));
  });
  await new Promise((r) => server.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-action-'));
  const env = { DOCTOR_URLS: `http://127.0.0.1:${server.address().port}/paid`, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'), GITHUB_OUTPUT: path.join(dir, 'output') };
  const log = console.log;
  const printed = [];
  console.log = (line) => printed.push(String(line));
  try {
    assert.equal(await main({ ...env, DOCTOR_FAIL_ON: 'fail' }), 1);
    assert.equal(await main({ ...env, DOCTOR_FAIL_ON: 'never' }), 0);
  } finally {
    console.log = log;
    server.close();
  }
  assert.ok(printed.some((l) => l.startsWith('::error title=x402 Doctor accepts[0]-payto')), printed.join('\n'));
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /## x402 Doctor: ❌ fail/);
  const output = fs.readFileSync(env.GITHUB_OUTPUT, 'utf8');
  assert.match(output, /^overall=fail$/m);
  const json = output.match(/report<<X402_DOCTOR_EOF\n(.*)\nX402_DOCTOR_EOF/)[1];
  assert.equal(JSON.parse(json)[0].overall, 'fail');
});

test('action: bad inputs are refused before any request', async () => {
  await assert.rejects(main({ DOCTOR_URLS: '' }), /"urls" input is empty/);
  await assert.rejects(main({ DOCTOR_URLS: 'not a url' }), /not a valid URL/);
  await assert.rejects(main({ DOCTOR_URLS: 'https://a.example/', DOCTOR_METHOD: 'PUT' }), /GET or POST/);
  await assert.rejects(main({ DOCTOR_URLS: 'https://a.example/', DOCTOR_FAIL_ON: 'sometimes' }), /fail, warn or never/);
});
