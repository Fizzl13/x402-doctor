// Where to reach a seller (lib/contact.js): openapi.json first, then the x402 manifest, security.txt and a
// mailto: on the homepage; placeholders and no-reply addresses never count.
const test = require('node:test');
const assert = require('node:assert/strict');
const { findContact, usable } = require('../lib/contact');

const site = (pages) => async (url) => {
  const path = new URL(url).pathname;
  return path in pages ? { status: 200, text: pages[path], truncated: false } : { status: 404, text: '', truncated: false };
};

test('openapi.json contact first, then the manifest, security.txt, the homepage', async () => {
  const all = {
    '/openapi.json': JSON.stringify({ info: { contact: { email: 'api@seller.dev' } } }),
    '/.well-known/x402': JSON.stringify({ resources: [], owner: { contact: 'x402@seller.dev' } }),
    '/.well-known/security.txt': 'Contact: mailto:security@seller.dev\nExpires: 2027-01-01T00:00:00Z',
    '/': '<a href="mailto:hello@seller.dev?subject=hi">mail us</a>',
  };
  assert.deepEqual(await findContact(site(all), 'https://seller.dev'), { email: 'api@seller.dev', source: 'openapi.json' });
  delete all['/openapi.json'];
  assert.deepEqual(await findContact(site(all), 'https://seller.dev'), { email: 'x402@seller.dev', source: '.well-known/x402' });
  delete all['/.well-known/x402'];
  assert.deepEqual(await findContact(site(all), 'https://seller.dev'), { email: 'security@seller.dev', source: 'security.txt' });
  delete all['/.well-known/security.txt'];
  assert.deepEqual(await findContact(site(all), 'https://seller.dev'), { email: 'hello@seller.dev', source: 'homepage' });
  delete all['/'];
  assert.equal(await findContact(site(all), 'https://seller.dev'), null);
});

test('placeholders, no-reply and broken pages are skipped; never throws', async () => {
  for (const e of ['you@example.com', 'noreply@seller.dev', 'no-reply@seller.dev', 'user@domain.com', 'abc@sentry.io', 'logo@2x.png', 'not an email']) assert.equal(usable(e), null, e);
  assert.equal(usable('mailto:Ops@Seller.dev?subject=x'), 'ops@seller.dev');
  const pages = { '/openapi.json': '{not json', '/': '<a href="mailto:you@example.com">x</a><a href="mailto:%E0%A4%A">y</a><a href="mailto:team@seller.dev">z</a>' };
  assert.deepEqual(await findContact(site(pages), 'https://seller.dev'), { email: 'team@seller.dev', source: 'homepage' });
  assert.equal(await findContact(async () => { throw new Error('down'); }, 'https://seller.dev'), null);
  assert.equal(await findContact(async () => ({ status: 200, text: 'x'.repeat(10), truncated: true }), 'https://seller.dev'), null);
});
