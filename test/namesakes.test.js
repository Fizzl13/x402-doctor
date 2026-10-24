// Namesakes (lib/namesakes.js): one service name listed by several owners. Owners are joined by a shared payout
// address, a shared host-name word or three shared names; the best-known owner is the original; only brands count.
const test = require('node:test');
const assert = require('node:assert/strict');
const { casesOf, createBrandCheck, namesakeEntries, namesakeReason, lesserOf, nameOf, ownSiteName } = require('../lib/namesakes');

const item = (resource, serviceName, payTo, payers = 0, calls = payers * 3, description = `${serviceName} service`) => ({ resource, serviceName, description, accepts: [{ network: 'eip155:8453', payTo }], quality: { l30DaysUniquePayers: payers, l30DaysTotalCalls: calls } });

test('names: trimmed, lower case, spaces collapsed; too short or too long is no name', () => {
  assert.equal(nameOf('  X402   Doctor '), 'x402 doctor');
  assert.equal(nameOf('ab'), null);
  assert.equal(nameOf('x'.repeat(61)), null);
  assert.equal(nameOf(undefined), null);
});

test('cases: the original has the most payers; one owner on two sites is no case', () => {
  const cases = casesOf([
    item('https://x402-doctor.fizzl.eu/api/v1/preflight', 'X402 Doctor', '0xAAA', 6),
    item('https://x402-doctor.onrender.com/api/v1/diagnose', 'X402 Doctor', '0xaaa', 3),
    item('https://doctor.promoclube.online/diagnose', 'X402 Doctor', '0xBBB', 4),
    // one owner: a shared payout address
    item('https://stablestudio.dev/api/upload', 'StableStudio', '0xCCC', 14),
    item('https://stablestudio.io/api/upload', 'StableStudio', '0xccc', 4),
    // one owner: a shared host-name word (production and staging)
    item('https://x402check.xyz/check', 'x402check', '0xDDD', 6),
    item('https://x402check.arden-instance.workers.dev/check', 'x402check', '0xEEE', 4),
    // a tie: neither is the better-known one
    item('https://a-one.com/x', 'Tuski', '0x111', 1, 3),
    item('https://b-two.io/x', 'Tuski', '0x222', 1, 3),
  ]);
  assert.deepEqual(cases.map((c) => c.label), ['X402 Doctor']);
  const [c] = cases;
  assert.deepEqual(c.original.sites, ['fizzl.eu', 'x402-doctor.onrender.com'], 'the payout address joins the Render host');
  assert.equal(c.original.payers, 6);
  assert.deepEqual(c.namesakes.map((n) => [n.sites, n.payers, n.keys]), [[['promoclube.online'], 4, ['https://doctor.promoclube.online/diagnose']]]);
});

test('cases: two sites that share three or more names are one operator', () => {
  const names = ['MacroPulse', 'GridPulse', 'TradePulse'];
  const items = names.flatMap((n, i) => [item(`https://lonestaroracle.xyz/${i}`, n, '0x01', 5), item(`https://theaslangroupllc.com/${i}`, n, '0x02', 2)]);
  assert.deepEqual(casesOf(items), []);
  assert.equal(casesOf(items.slice(0, 4)).length, 2, 'two shared names are not enough');
});

test('entries: only brands, only namesakes with fewer payers; the reason names the original', () => {
  const cases = casesOf([
    item('https://x402-doctor.fizzl.eu/api/v1/preflight', 'X402 Doctor', '0xAAA', 6),
    item('https://doctor.promoclube.online/diagnose', 'X402 Doctor', '0xBBB', 4),
    item('https://doctor.promoclube.online/preflight', 'X402 Doctor', '0xBBB', 2),
    item('https://uuid.example-one.com/v4', 'UUID Generator', '0x0C', 6),
    item('https://other-uuid.dev/v4', 'UUID Generator', '0x0D', 2),
  ]);
  assert.equal(cases.length, 2);
  const entries = namesakeEntries(cases, { 'x402 doctor': 0.89, 'uuid generator': 0.81 });
  assert.deepEqual(Object.keys(entries).sort(), ['https://doctor.promoclube.online/diagnose', 'https://doctor.promoclube.online/preflight']);
  const ns = entries['https://doctor.promoclube.online/diagnose'];
  assert.deepEqual(ns, { name: 'X402 Doctor', original: { site: 'x402-doctor.fizzl.eu', url: 'https://x402-doctor.fizzl.eu/api/v1/preflight', payers: 6 }, payers: 4 });
  assert.match(namesakeReason(ns).message, /"X402 Doctor" is also at x402-doctor\.fizzl\.eu/);
  assert.equal(namesakeReason(null), null);
  const even = { ...cases[0], namesakes: [{ ...cases[0].namesakes[0], payers: 6 }] };
  assert.deepEqual(lesserOf(even), [], 'as many payers as the original: neither is the better-known one');
});

test('Jev: one question per name in batches, with the original description; off without a key; failures skip the batch', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, { type: 'noul', noul: i === 0 ? 0.91 : 0.12 }])) });
  };
  const cases = Array.from({ length: 30 }, (_, i) => ({ name: `name ${i}`, label: `Name ${i}`, original: { description: `does ${i}` } }));
  const out = await createBrandCheck({ apiKey: 'k', fetch, log: { warn() {} } }).brands(cases);
  assert.equal(calls.length, 2, '25 names per request');
  assert.deepEqual(calls[0].state.names[0], { name: 'Name 0', description: 'does 0' });
  assert.match(calls[0].questions.n0.instructions, /`names\[0\]\.name`/);
  assert.equal(out['name 0'], 0.91);
  assert.equal(out['name 1'], 0.12);
  assert.equal(out['name 25'], 0.91);
  assert.deepEqual(await createBrandCheck({ apiKey: '' }).brands(cases), {});
  const failing = await createBrandCheck({ apiKey: 'k', fetch: async () => new Response('{}', { status: 529 }), log: { warn() {} } }).brands(cases);
  assert.deepEqual(failing, {});
});

test('the track-record lookup returns the namesake mark from the index', () => {
  const { lookupIn, templatesOf } = require('../lib/trust-index');
  const ns = { name: 'X402 Doctor', original: { site: 'fizzl.eu', url: 'https://x402-doctor.fizzl.eu/api/v1/preflight', payers: 6 }, payers: 4 };
  const index = { days: ['2026-10-21', '2026-10-22', '2026-10-23'], resources: { 'https://doctor.promoclube.online/diagnose': { url: 'https://doctor.promoclube.online/diagnose', h: 'ggg', last: { verdict: 'go' }, ns }, 'https://x402-doctor.fizzl.eu/api/v1/preflight': { url: 'https://x402-doctor.fizzl.eu/api/v1/preflight', h: 'ggg', last: { verdict: 'go' } } } };
  const templates = templatesOf(index.resources);
  assert.deepEqual(lookupIn(index, templates, 'https://doctor.promoclube.online/diagnose').namesake, ns);
  assert.equal(lookupIn(index, templates, 'https://x402-doctor.fizzl.eu/api/v1/preflight').namesake, undefined);
});

test("a name that is the original's own site name is a brand whatever Jev says; a description is not", () => {
  const cases = casesOf([
    item('https://x402-doctor.fizzl.eu/api/v1/preflight', 'X402 Doctor', '0xAAA', 6),
    item('https://doctor.promoclube.online/diagnose', 'X402 Doctor', '0xBBB', 4),
    item('https://x402-gateway.ai/api/v1/ping', 'x402-gateway', '0x0A', 6),
    item('https://x402.freeq.one/tools/markdown', 'x402-gateway', '0x0B', 4),
    item('https://api.searchco.com/search', 'Web Search', '0x0E', 9),
    item('https://websearcher.dev/q', 'Web Search', '0x0F', 2),
    item('https://data.site-a.com/x', 'Data', '0x10', 5),
    item('https://data.site-b.io/x', 'Data', '0x11', 1),
    // a subdomain named after what the tool does, and a single coined word on a shared host
    item('https://asn-lookup.underscoredone.com/q', 'ASN Lookup', '0x12', 5),
    item('https://flat-rate-llm.kikoribera03.workers.dev/asn', 'ASN Lookup', '0x13', 4),
    item('https://tablegrab.onrender.com/grab', 'TableGrab', '0x14', 3),
    item('https://priceplain.onrender.com/grab', 'TableGrab', '0x15', 1),
  ]);
  const byName = Object.fromEntries(cases.map((c) => [c.name, c]));
  assert.deepEqual(byName['x402 doctor'].original.hosts, ['x402-doctor.fizzl.eu']);
  assert.equal(ownSiteName(byName['x402 doctor']), true, 'x402-doctor.fizzl.eu');
  assert.equal(ownSiteName(byName['x402-gateway']), true, 'x402-gateway.ai');
  assert.equal(ownSiteName(byName['web search']), false, "not the original's site name");
  assert.equal(ownSiteName(byName.data), false, 'too short to tell');
  assert.equal(ownSiteName(byName['asn lookup']), false, 'a descriptive subdomain');
  assert.equal(ownSiteName(byName.tablegrab), true, 'the first label on a shared host');
  // Jev's answers of 24 Oct 2026: "x402 doctor" 0.17, "x402-gateway" 0.87.
  const entries = namesakeEntries(cases, { 'x402 doctor': 0.17, 'x402-gateway': 0.87, 'web search': 0.09, data: 0.05, 'asn lookup': 0.08, tablegrab: 0.61 });
  assert.deepEqual(Object.keys(entries).sort(), ['https://doctor.promoclube.online/diagnose', 'https://priceplain.onrender.com/grab', 'https://x402.freeq.one/tools/markdown']);
  assert.equal(entries['https://doctor.promoclube.online/diagnose'].original.site, 'x402-doctor.fizzl.eu');
});
