// The XRPL AI Hub as a Trust Index source (lib/trust-scan.js loadXrplHub) against a fake xrpl-ai.org: the merchant
// list over its pages, each merchant's resources from the page data Next.js streams in, and what is left out
// (inactive, testnet, not https, another merchant's). No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadXrplHub, nextPageData, hubResources } = require('../lib/trust-scan');

const A = 'rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32';
const B = 'rfryheo6yzFdLWj8qUQtZc7zG9MKkBkUEy';
const C = 'r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf';

// A page whose data comes in two self.__next_f.push chunks, as the hub's pages do (split mid-object on purpose).
function pageWith(resources) {
  const data = `0:["$","div",null,{"children":"Offered APIs"}]\n1:["$","$L31",null,{"resources":${JSON.stringify(resources)}}]`;
  const cut = Math.floor(data.length / 2);
  const push = (part) => `<script>self.__next_f.push([1,${JSON.stringify(part)}])</script>`;
  return `<html><body><h1>Merchant</h1>${push(data.slice(0, cut))}${push(data.slice(cut))}</body></html>`;
}
const resource = (merchantAddr, url, extra = {}) => ({ id: `id-${url}`, merchantAddr, url, name: `Name of ${url}`, description: `What ${url} does, with "quotes" and {braces}`, priceAmount: '0.01', network: 'xrpl:0', isActive: true, ...extra });

function fakeHub(pages) {
  const asked = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    asked.push(path);
    if (!(path in pages)) return new Response('not found', { status: 404 });
    const body = pages[path];
    return body instanceof Response ? body : new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  return { fetchImpl, asked };
}

test('nextPageData and hubResources: resource objects from chunked page data, strings with braces and quotes intact', () => {
  const html = pageWith([resource(A, 'https://a.example/v1/x'), resource(A, 'https://a.example/v1/y')]);
  const found = hubResources(nextPageData(html));
  assert.deepEqual(found.map((r) => r.url), ['https://a.example/v1/x', 'https://a.example/v1/y']);
  assert.equal(found[0].description, 'What https://a.example/v1/x does, with "quotes" and {braces}');
  assert.deepEqual(hubResources(nextPageData('<html>no data</html>')), []);
});

test('loadXrplHub: every merchant over the pages, their active mainnet https resources, and every merchant address', async () => {
  const hub = fakeHub({
    '/merchants?page=1': `<p>Page 1 of 2</p><a href="/address/${A}">A</a><a href="/address/${B}">B</a><a href="/address/rNotAnAddress">x</a>`,
    '/merchants?page=2': `<p>Page 2 of 2</p><a href="/address/${C}">C</a><a href="/address/${A}">A again</a>`,
    [`/address/${A}`]: pageWith([
      resource(A, 'https://a.example/v1/x'),
      resource(A, 'https://a.example/v1/x?again=1'), // the same origin + path: once
      resource(A, 'https://a.example/v1/old', { isActive: false }),
      resource(A, 'https://a.example/v1/test', { network: 'xrpl:1' }),
      resource(A, 'http://a.example/v1/plain'),
      resource(C, 'https://c.example/listed-on-a'), // another merchant's resource on this page
    ]),
    [`/address/${B}`]: pageWith([]), // paid, but lists no API
    // C's page fails: skipped, the rest still loads.
  });
  const { resources, merchants } = await loadXrplHub({ fetchImpl: hub.fetchImpl, sleep: async () => {}, pauseMs: 0 });
  assert.deepEqual(merchants.sort(), [A, B, C].sort());
  assert.deepEqual(resources.map((r) => r.url), ['https://a.example/v1/x']);
  assert.match(resources[0].description, /^What https:\/\/a\.example\/v1\/x does/);
  assert.ok(resources[0].key);
  assert.ok(hub.asked.includes('/merchants?page=2'), 'follows "Page 1 of N"');
});

test('loadXrplHub: no merchant list is an error (the scan goes on without the hub); busy pages are asked again', async () => {
  await assert.rejects(loadXrplHub({ fetchImpl: async () => new Response('down', { status: 503 }), sleep: async () => {}, pauseMs: 0 }), /merchants page did not answer/);
  let tries = 0;
  const flaky = async (url) => {
    if (new URL(url).pathname === '/merchants' && tries++ === 0) return new Response('busy', { status: 429 });
    if (new URL(url).pathname === '/merchants') return new Response(`<a href="/address/${A}">A</a>`, { status: 200 });
    return new Response(pageWith([resource(A, 'https://a.example/v1/x')]), { status: 200 });
  };
  const { resources } = await loadXrplHub({ fetchImpl: flaky, sleep: async () => {}, pauseMs: 0 });
  assert.equal(resources.length, 1);
  assert.equal(tries, 2);
});
