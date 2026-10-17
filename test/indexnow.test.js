// IndexNow: the key file and llms.txt are served, the sitemap URLs are submitted once, and only on Render.
process.env.BASE_RPC_URL = 'http://127.0.0.1:1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INDEXNOW_KEY, sitemapUrls, pingIndexNow, scheduleIndexNow } = require('../lib/indexnow');

const quiet = { log() {}, warn() {} };

test('sitemapUrls reads every <loc>', () => {
  const xml = fs.readFileSync(path.join(__dirname, '..', 'public', 'sitemap.xml'), 'utf8');
  const urls = sitemapUrls(xml);
  assert.ok(urls.includes('https://x402-doctor.fizzl.eu/'));
  assert.ok(urls.includes('https://x402-doctor.fizzl.eu/stellar'));
  assert.ok(urls.every((u) => u.startsWith('https://x402-doctor.fizzl.eu/')));
});

test('pingIndexNow posts host, key, key location and the URLs of that host only, once each', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('', { status: 202 }); };
  const status = await pingIndexNow({ host: 'x402-doctor.fizzl.eu', urls: ['https://x402-doctor.fizzl.eu/', 'https://x402-doctor.fizzl.eu/', 'https://evil.example/x', 'https://x402-doctor.fizzl.eu/llms.txt'], fetchImpl, log: quiet });
  assert.equal(status, 202);
  assert.equal(calls[0].url, 'https://api.indexnow.org/indexnow');
  assert.deepEqual(calls[0].body, { host: 'x402-doctor.fizzl.eu', key: INDEXNOW_KEY, keyLocation: `https://x402-doctor.fizzl.eu/${INDEXNOW_KEY}.txt`, urlList: ['https://x402-doctor.fizzl.eu/', 'https://x402-doctor.fizzl.eu/llms.txt'] });
  assert.equal(await pingIndexNow({ host: 'x402-doctor.fizzl.eu', urls: [], fetchImpl, log: quiet }), null);
  assert.equal(await pingIndexNow({ host: 'x402-doctor.fizzl.eu', urls: ['https://x402-doctor.fizzl.eu/'], fetchImpl: async () => { throw new Error('down'); }, log: quiet }), null);
});

test('scheduleIndexNow runs only on Render, and INDEXNOW=off turns it off', async () => {
  let pinged = 0;
  const fetchImpl = async () => { pinged += 1; return new Response('', { status: 200 }); };
  assert.equal(scheduleIndexNow({ env: {}, host: 'x402-doctor.fizzl.eu', urls: ['https://x402-doctor.fizzl.eu/'], fetchImpl, log: quiet }), null);
  assert.equal(scheduleIndexNow({ env: { RENDER: 'true', INDEXNOW: 'off' }, host: 'x402-doctor.fizzl.eu', urls: ['https://x402-doctor.fizzl.eu/'], fetchImpl, log: quiet }), null);
  const timer = scheduleIndexNow({ env: { RENDER: 'true' }, host: 'x402-doctor.fizzl.eu', urls: () => ['https://x402-doctor.fizzl.eu/'], delayMs: 5, fetchImpl, log: quiet });
  assert.ok(timer);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pinged, 1);
});

test('the key file and llms.txt are served', async () => {
  const { createApp } = require('../server');
  const app = createApp({ allowPrivate: true, env: {}, bazaarIndex: { lookup: async () => ({ resource: false, origin: false }) } });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const key = await fetch(`${base}/${INDEXNOW_KEY}.txt`);
    assert.equal(key.status, 200);
    assert.equal((await key.text()).trim(), INDEXNOW_KEY);
    const llms = await fetch(`${base}/llms.txt`);
    assert.equal(llms.status, 200);
    const text = await llms.text();
    assert.match(text, /^# x402 Doctor\n\n> /);
    assert.match(text, /\/api\/v1\/preflight/);
  } finally {
    server.close();
  }
});
