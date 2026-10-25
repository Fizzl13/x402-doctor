// The Render address sends every request to x402-doctor.fizzl.eu (lib/canonical-host.js), the health check aside.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { canonicalHost } = require('../lib/canonical-host');
const { createApp } = require('../server');

// What the middleware does with one request: { next: true } or the redirect it sends.
const run = (host, originalUrl, path = originalUrl.split('?')[0]) => {
  let out = null;
  const res = { redirect: (status, url) => { out = { status, url }; } };
  canonicalHost('https://x402-doctor.fizzl.eu')({ headers: { host }, originalUrl, path }, res, () => { out = { next: true }; });
  return out;
};

test('canonical host: the Render address goes to x402-doctor.fizzl.eu with 308, the health check and other hosts stay', () => {
  assert.deepEqual(run('x402-doctor.onrender.com', '/api/v1/preflight?url=https://example.com'), { status: 308, url: 'https://x402-doctor.fizzl.eu/api/v1/preflight?url=https://example.com' });
  assert.deepEqual(run('X402-Doctor.onrender.com:443', '/'), { status: 308, url: 'https://x402-doctor.fizzl.eu/' });
  assert.deepEqual(run('x402-doctor.onrender.com', '/api/health'), { next: true }, "Render's own probe");
  assert.deepEqual(run('x402-doctor.fizzl.eu', '/api/v1/diagnose'), { next: true });
  assert.deepEqual(run('127.0.0.1:4021', '/'), { next: true });
});

// A request with its own Host header (fetch doesn't let a caller set Host).
const get = (base, path, host) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ hostname: u.hostname, port: u.port, path, headers: host ? { host } : {} }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); }).on('error', reject);
});

test('canonical host: wired into the app before everything else', async () => {
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const app = createApp({ allowPrivate: true, env: {}, trustIndex });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await get(base, '/api/v1/preflight?url=https://example.com', 'x402-doctor.onrender.com'), { status: 308, location: 'https://x402-doctor.fizzl.eu/api/v1/preflight?url=https://example.com' });
    assert.equal((await get(base, '/api/health', 'x402-doctor.onrender.com')).status, 200, 'the health check answers on the Render address');
    assert.notEqual((await get(base, '/api/v1/preflight?url=https://example.com')).status, 308, 'any other host is answered as before');
  } finally { server.close(); }
});
