const test = require('node:test');
const assert = require('node:assert/strict');
const { onPublicHost } = require('../lib/public-host');

const seen = (req) => `${req.protocol}://${req.headers.host}${req.originalUrl}`;
const run = (host, protocol = 'https') => new Promise((done) => {
  let url;
  const req = Object.create({ get protocol() { return protocol; } });
  Object.assign(req, { headers: { host }, originalUrl: '/api/v1/diagnose?url=https://example.com' });
  onPublicHost('https://x402-doctor.fizzl.eu', (r, _res, next) => { url = seen(r); next(); })(req, {}, () => done({ url, after: seen(req) }));
});

test('public host: the paywall sees x402-doctor.fizzl.eu for requests on the Render address, and only the paywall', async () => {
  assert.deepEqual(await run('x402-doctor.onrender.com', 'http'), { url: 'https://x402-doctor.fizzl.eu/api/v1/diagnose?url=https://example.com', after: 'http://x402-doctor.onrender.com/api/v1/diagnose?url=https://example.com' });
  assert.equal((await run('x402-doctor.fizzl.eu')).url, 'https://x402-doctor.fizzl.eu/api/v1/diagnose?url=https://example.com');
  assert.equal((await run('localhost:3000', 'http')).url, 'http://localhost:3000/api/v1/diagnose?url=https://example.com'); // local runs stay as they are
});
