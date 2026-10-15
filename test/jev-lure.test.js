// Bait check (lib/jev-lure.js): off without a key, brand domains skip the impersonation question, the output
// question only when an output is declared, reasons by threshold, nothing when Jev fails, and the preflight
// adding caution or info but never no_go.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLure, lureReasons, claimsOf, carryBait, QUESTIONS, BAIT_VERSION } = require('../lib/jev-lure');

const quiet = { warn() {} };
const jev = (answers, status = 200) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (status !== 200) return new Response('{}', { status });
    return Response.json({ answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { type: 'noul', noul: v }])) });
  };
  return { fetch, calls };
};

test('claimsOf: v2 description first, then v1; output from the Bazaar example or a v1 outputSchema', () => {
  assert.equal(claimsOf(null), null);
  assert.equal(claimsOf({ accepts: [{}] }), null);
  assert.deepEqual(claimsOf({ resource: { description: ' BTC price ' }, accepts: [{ description: 'other' }] }), { description: 'BTC price', output: '' });
  const v1 = claimsOf({ accepts: [{ description: 'Weather', outputSchema: { output: { temp: 'number' } } }] });
  assert.equal(v1.description, 'Weather');
  assert.match(v1.output, /temp/);
  assert.equal(v1.output, '{"temp":"number"}', 'only the output side of a v1 { input, output } schema');
  const ex = claimsOf({ resource: { description: 'Funding rates' }, accepts: [{}], extensions: { bazaar: { info: { output: { example: { rate: 0.01 } } } } } });
  assert.equal(ex.output, '{"rate":0.01}');
});

test('lure: off without a key; asks only what applies; caches; null on failure', async () => {
  assert.equal(createLure({ apiKey: '' }).enabled, false);
  const j = jev({ impersonation: 0.9, lure: 0.1, mismatch: 0.2 });
  const l = createLure({ apiKey: 'k', fetch: j.fetch, log: quiet });
  assert.equal(await l.judge('x.example', null), null);
  const r = await l.judge('Coinbase-API.example', { description: 'Official Coinbase price API', output: '{"price":1}' });
  assert.deepEqual(r, { impersonation: 0.9, lure: 0.1, mismatch: 0.8 }); // mismatch = 1 - "fits"
  assert.deepEqual(Object.keys(j.calls[0].body.questions).sort(), ['impersonation', 'lure', 'mismatch']);
  assert.equal(j.calls[0].body.state.host, 'coinbase-api.example');
  await l.judge('coinbase-api.example', { description: 'Official Coinbase price API', output: '{"price":1}' });
  assert.equal(j.calls.length, 1);
  // On the brand's own domain there is no impersonation question; without an output, no mismatch question.
  const k = jev({ lure: 0.2 });
  const own = await createLure({ apiKey: 'k', fetch: k.fetch, log: quiet }).judge('api.cdp.coinbase.com', { description: 'Coinbase data', output: '' });
  assert.deepEqual(own, { impersonation: null, lure: 0.2, mismatch: null });
  assert.deepEqual(Object.keys(k.calls[0].body.questions), ['lure']);
  assert.equal(await createLure({ apiKey: 'k', fetch: jev({}, 529).fetch, log: quiet }).judge('a.example', { description: 'x', output: '' }), null);
  assert.equal(await createLure({ apiKey: 'k', fetch: jev({}).fetch, log: quiet }).judge('a.example', { description: 'x', output: '' }), null);
});

test('lureReasons: caution when sure, info in between, nothing below', () => {
  assert.deepEqual(lureReasons(null), []);
  const r = lureReasons({ impersonation: 0.9, lure: 0.6, mismatch: 0.3 });
  assert.deepEqual(r.map((x) => [x.level, x.code]), [['caution', 'brand_impersonation'], ['info', 'lure_description']]);
  assert.match(r[0].message, /TypeSafe Jev/);
  assert.deepEqual(lureReasons({ impersonation: null, lure: 0.1, mismatch: 0.89 }).map((x) => [x.level, x.code]), [['info', 'output_mismatch']]);
  assert.deepEqual(lureReasons({ impersonation: null, lure: 0.1, mismatch: 0.97 }).map((x) => x.level), ['caution']);
});

test('impersonation question: claiming to be the brand counts, reselling or proxying its product does not', () => {
  const q = QUESTIONS.impersonation.instructions;
  assert.match(q, /resells, proxies, wraps or reports on is not impersonation/);
  assert.match(q, /"GPT-4o and Claude through one gateway"/, 'an LLM gateway naming the models it serves is the not-impersonation example');
  assert.doesNotMatch(q, /OpenAI GPT endpoint/, 'the old example that made Jev flag LLM gateways is gone');
  assert.doesNotMatch(q, /x402engine/, 'no flagged seller in the question itself: its next answer has to come from the rule');
  assert.match(q, /"Official Coinbase API"/);
  assert.match(QUESTIONS.impersonation.criteria.false, /resells, proxies or reports on/);
});

test('carryBait: same version keeps all answers; after a change only clear ones, unless Jev is off', () => {
  const previous = { bait_version: BAIT_VERSION - 1, bait: { gateway: [0.95, 0.03], unsure: [0.6, 0.1], lure: [0.1, 0.9], clean: [0.05, 0.02], half: [null, 0.2] } };
  assert.deepEqual(Object.keys(carryBait(previous)).sort(), ['clean', 'half'], 'flagged and unsure answers are asked again');
  assert.deepEqual(Object.keys(carryBait(previous, { enabled: false })).sort(), ['clean', 'gateway', 'half', 'lure', 'unsure'], 'without Jev nothing could be asked again');
  assert.deepEqual(Object.keys(carryBait({ ...previous, bait_version: BAIT_VERSION })).length, 5);
  assert.deepEqual(carryBait({ bait: { clean: [0.1, 0.1] } }), { clean: [0.1, 0.1] }, 'a file from before versions counts as an older version');
  assert.deepEqual(carryBait(null), {});
});
