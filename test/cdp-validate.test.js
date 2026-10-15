'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCdpValidator, cdpFindings } = require('../lib/cdp-validate');
const { checkCdpValidate } = require('../lib/diagnose');

const BASE = 'eip155:8453';
const ok = (over = {}) => ({ valid: true, statusCode: 402, x402Version: 2, preflight: [{ check: 'returns_402', passed: true, detail: 'Endpoint correctly returns HTTP 402 Payment Required', severity: 'required' }], simulation: { outcome: 'accepted' }, index: null, ...over });
// As CDP answers for an x402 v1 endpoint: one real failure, then every later check "Skipped".
const v1 = () => ({
  valid: false,
  statusCode: 402,
  x402Version: null,
  preflight: [
    { check: 'returns_402', passed: true, detail: 'Endpoint correctly returns HTTP 402 Payment Required', severity: 'required' },
    { check: 'x402_version', passed: false, detail: 'Endpoint uses x402 v1 — upgrade to x402 v2 to be discoverable in the bazaar', expected: '2', actual: '1', severity: 'required' },
    { check: 'has_accepts', passed: false, detail: 'Skipped: endpoint uses x402 v1 (upgrade to v2)', severity: 'required' },
    { check: 'bazaar.info.output', passed: false, detail: 'Skipped: endpoint uses x402 v1 (upgrade to v2)', severity: 'advisory' },
    { check: 'parse', passed: false, detail: 'Skipped: preflight checks failed', severity: 'required' },
  ],
  simulation: { outcome: 'rejected', rejectionReason: 'endpoint uses x402 v1; upgrade to x402 v2 for bazaar discovery' },
  index: { active: true, lastCrawledAt: '2026-10-15T02:45:18.045Z' },
});

test('CDP validator: posts resource and method, caches 10 minutes, refuses an error or an odd answer', async () => {
  const calls = [];
  let answer = ok();
  let status = 200;
  let clock = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status === 200, status, json: async () => answer };
  };
  const cdp = createCdpValidator({ url: 'https://cdp.test/validate', fetchImpl, now: () => clock });
  assert.equal((await cdp.validate('https://api.example.com/paid', 'POST')).valid, true);
  assert.deepEqual(calls[0], { url: 'https://cdp.test/validate', body: { resource: 'https://api.example.com/paid', method: 'POST' } });
  await cdp.validate('https://api.example.com/paid', 'POST');
  assert.equal(calls.length, 1, 'the second ask within 10 minutes comes from the cache');
  await cdp.validate('https://api.example.com/paid', 'GET');
  assert.equal(calls.length, 2, 'another method is another answer');
  clock = 10 * 60 * 1000;
  await cdp.validate('https://api.example.com/paid', 'POST');
  assert.equal(calls.length, 3, 'asked again after 10 minutes');

  status = 503;
  await assert.rejects(cdp.validate('https://api.example.com/other'), /CDP validate HTTP 503/);
  status = 200;
  answer = { errorType: 'invalid_request' };
  await assert.rejects(cdp.validate('https://api.example.com/third'), /unexpected answer/);
});

test('CDP findings: "Skipped" lines are left out, advisory apart, accepted only when valid and the simulation accepts', () => {
  const f = cdpFindings(v1());
  assert.equal(f.accepted, false);
  assert.deepEqual(f.required.map((c) => c.check), ['x402_version']);
  assert.deepEqual(f.advisory, []);
  assert.equal(f.rejectionReason, 'endpoint uses x402 v1; upgrade to x402 v2 for bazaar discovery');
  assert.equal(cdpFindings(ok()).accepted, true);
  assert.equal(cdpFindings(ok({ simulation: { outcome: 'rejected', rejectionReason: 'x' } })).accepted, false);
});

test('cdp-validate check: pass with advice, warn on a Base endpoint CDP rejects, info without Base or Solana, silent otherwise', async () => {
  const run = async (answer, { url = 'https://api.example.com/paid', method = 'GET', accepts = [{ network: BASE }] } = {}) => {
    const checks = [];
    const asked = [];
    const cdpValidate = { validate: async (u, m) => { asked.push([u, m]); if (answer instanceof Error) throw answer; return answer; } };
    await checkCdpValidate(url, method, { accepts }, cdpValidate, checks);
    return { check: checks[0], asked };
  };

  const pass = (await run(ok())).check;
  assert.deepEqual([pass.id, pass.status, pass.group], ['cdp-validate', 'pass', 'discovery']);
  assert.equal(pass.message, "Coinbase's own validator (CDP) accepts this endpoint: the CDP facilitator would index it in the Bazaar after a settled payment.");
  const advice = ok({ preflight: [{ check: 'bazaar.info.output', passed: false, detail: 'No output example declared.', severity: 'advisory' }] });
  assert.match((await run(advice)).check.message, /CDP also suggests: No output example declared\.$/);

  const { check: warn, asked } = await run(v1(), { method: 'POST' });
  assert.deepEqual(asked, [['https://api.example.com/paid', 'POST']]);
  assert.equal(warn.status, 'warn');
  assert.equal(warn.message, "Coinbase's own validator (CDP) rejects this endpoint for the Bazaar: Endpoint uses x402 v1 — upgrade to x402 v2 to be discoverable in the bazaar.");
  assert.match(warn.hint, /curl -X POST https:\/\/api\.cdp\.coinbase\.com\/platform\/v2\/x402\/validate .*"resource":"https:\/\/api\.example\.com\/paid","method":"POST"/);

  const reasonOnly = { ...v1(), preflight: [] };
  assert.match((await run(reasonOnly)).check.message, /for the Bazaar: endpoint uses x402 v1; upgrade to x402 v2 for bazaar discovery\.$/);
  assert.equal((await run(v1(), { accepts: [{ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }] })).check.status, 'warn');
  assert.equal((await run(v1(), { accepts: [{ network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' }] })).check.status, 'info');

  const http = await run(ok(), { url: 'http://api.example.com/paid' });
  assert.deepEqual([http.check, http.asked], [undefined, []], 'CDP takes HTTPS only: not asked');
  assert.equal((await run(new Error('timeout'))).check, undefined, 'no answer from CDP: say nothing');
});
