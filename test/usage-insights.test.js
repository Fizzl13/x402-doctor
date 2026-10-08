const test = require('node:test');
const assert = require('node:assert/strict');
const { languageOf, createAgentKinds, createDownloads } = require('../lib/usage-insights');

test('languageOf: the language of a caller from its user agent', () => {
  assert.equal(languageOf('node'), 'JavaScript');
  assert.equal(languageOf('axios/1.18.1'), 'JavaScript');
  assert.equal(languageOf('presign-guard-ai-sdk/0.3.0'), 'JavaScript');
  assert.equal(languageOf('fizzl-langchain/0.1.1'), 'JavaScript');
  assert.equal(languageOf('python-httpx/0.28.1'), 'Python');
  assert.equal(languageOf('fizzl-py/0.4.0'), 'Python');
  assert.equal(languageOf('Go-http-client/2.0'), 'Go');
  assert.equal(languageOf('GuzzleHttp/7'), 'PHP');
  assert.equal(languageOf('curl/8.5.0'), 'curl/shell');
  assert.equal(languageOf('browser'), 'Browser');
  assert.equal(languageOf('CarbonMonitor/0.1'), 'Own name');
  assert.equal(languageOf('none'), 'Not sent');
});

test('agent kinds: libraries by name, made-up names judged once by Jev, unknown until then', async () => {
  let calls = 0;
  const fetch = async (_url, opts) => {
    calls++;
    const agent = JSON.parse(opts.body).state.agent;
    const answers = agent === 'TradeLoop' ? { monitor: { noul: 0.1 }, directory: { noul: 0.2 }, agent: { noul: 0.9 } } : { monitor: { noul: 0.2 }, directory: { noul: 0.3 }, agent: { noul: 0.1 } };
    return { ok: true, json: async () => ({ answers }) };
  };
  const kinds = createAgentKinds({ apiKey: 'k', fetch, log: { warn() {} } });
  const events = [{ agent: 'node' }, { agent: 'TradeLoop/1.0' }, { agent: 'Zebra/2' }, { agent: 'mako-pulse-prober/0.1' }, { agent: 'presign-guard-wallet/0.9.1' }];
  const first = kinds.kindsFor(events);
  assert.equal(first.node, 'HTTP library (no name)');
  assert.equal(first['mako-pulse-prober/0.1'], 'Monitor or probe');
  assert.equal(first['presign-guard-wallet/0.9.1'], 'Our packages');
  assert.equal(first['TradeLoop/1.0'], 'Unknown');
  await new Promise((r) => setTimeout(r, 20));
  const second = kinds.kindsFor(events);
  assert.equal(second['TradeLoop/1.0'], 'Agent or app');
  assert.equal(second['Zebra/2'], 'Unknown');
  assert.equal(calls, 2, 'each made-up name is asked once');
  kinds.kindsFor(events);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
});

test('agent kinds: without a TypeSafe key nothing is asked', () => {
  const kinds = createAgentKinds({ apiKey: '', fetch: () => { throw new Error('no'); } });
  assert.equal(kinds.kindsFor([{ agent: 'TradeLoop/1.0' }])['TradeLoop/1.0'], 'Unknown');
});

test('downloads: npm and PyPI daily counts, a new package (404) is empty, cached', async () => {
  let calls = 0;
  const fetch = async (url) => {
    calls++;
    if (url.includes('presign-guard-ai-sdk') || url.includes('pypistats')) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ downloads: [{ day: '2026-10-05', downloads: 7 }, { day: '2026-10-06', downloads: 3 }] }) };
  };
  const d = createDownloads({ fetch });
  const a = await d.load();
  assert.deepEqual(a.packages.find((p) => p.name === 'x402-safe-fetch').days, { '2026-10-05': 7, '2026-10-06': 3 });
  assert.deepEqual(a.packages.find((p) => p.name === 'fizzl').days, {});
  assert.equal(a.packages.find((p) => p.name === 'fizzl').language, 'Python');
  const n = calls;
  await d.load();
  assert.equal(calls, n, 'served from the cache');
});
