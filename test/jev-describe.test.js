// Description quality (lib/jev-describe.js): off without a key, an info line with hints for a vague
// description, a pass for a clear one, and nothing when Jev fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDescribe, describeCheck } = require('../lib/jev-describe');

const quiet = { warn() {} };
const jev = (score, out, when, status = 200) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (status !== 200) return new Response('{}', { status });
    return Response.json({ answers: { clarity: { type: 'score', score }, says_output: { type: 'noul', noul: out }, says_when: { type: 'noul', noul: when } } });
  };
  return { fetch, calls };
};

test('describe: off without a key or text; rates and caches', async () => {
  assert.equal(createDescribe({ apiKey: '' }).enabled, false);
  const j = jev(2.7, 0.9, 0.8);
  const d = createDescribe({ apiKey: 'k', fetch: j.fetch, log: quiet });
  assert.equal(await d.rate(''), null);
  assert.deepEqual(await d.rate('Returns BTC funding rates as JSON; use before opening a perp position.'), { score: 2.7, says_output: 0.9, says_when: 0.8 });
  await d.rate('Returns BTC funding rates as JSON; use before opening a perp position.');
  assert.equal(j.calls.length, 1);
  assert.equal(j.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(j.calls[0].body.questions.clarity.type, 'score');
  assert.equal(await createDescribe({ apiKey: 'k', fetch: jev(0, 0, 0, 529).fetch, log: quiet }).rate('x'), null);
});

test('describeCheck: pass when clear, info with hints when vague', () => {
  assert.equal(describeCheck(null, 'resource.description'), null);
  const good = describeCheck({ score: 2.7, says_output: 0.9, says_when: 0.8 }, 'resource.description');
  assert.equal(good.status, 'pass');
  assert.equal(good.hint, undefined);
  const vague = describeCheck({ score: 0.4, says_output: 0.1, says_when: 0.2 }, 'accepts[0].description');
  assert.equal(vague.status, 'info');
  assert.match(vague.message, /accepts\[0\]\.description is unclear/);
  assert.match(vague.hint, /what the response contains.*and.*what task/);
  const half = describeCheck({ score: 2.2, says_output: 0.9, says_when: 0.3 }, 'resource.description');
  assert.equal(half.status, 'info');
  assert.doesNotMatch(half.hint, /response contains/);
});
