// The ERC-8004 registration file of an API on a subdomain may sit on the parent domain (api.example.com's
// identity in example.com/.well-known/agent-registration.json): used only when that file lists the subdomain's
// origin among its endpoints. Seen on 31 Oct 2026 in Grok's field test of the payee check. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { registrationFile } = require('../lib/diagnose');

const DOC = (endpoints) => JSON.stringify({ type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Seller', services: endpoints.map((e) => ({ name: 'web', endpoint: e })), registrations: [] });
const fetcher = (files) => async (url) => (files[url] ? { status: 200, text: files[url] } : { status: 404, text: 'not found' });

test('own file first', async () => {
  const r = await registrationFile('https://api.example.com', fetcher({ 'https://api.example.com/.well-known/agent-registration.json': DOC(['https://api.example.com/']) }));
  assert.deepEqual([r.res.status, r.fileHost, r.where], [200, 'api.example.com', 'https://api.example.com/.well-known/agent-registration.json']);
});

test('the parent domain when it lists this origin', async () => {
  const r = await registrationFile('https://api.example.com', fetcher({ 'https://example.com/.well-known/agent-registration.json': DOC(['https://example.com', 'https://api.example.com/v1/intel']) }));
  assert.deepEqual([r.res.status, r.fileHost, r.where], [200, 'example.com', 'https://example.com/.well-known/agent-registration.json']);
});

test('not the parent when it does not list this origin, and never above a two-label domain', async () => {
  const other = await registrationFile('https://api.example.com', fetcher({ 'https://example.com/.well-known/agent-registration.json': DOC(['https://example.com']) }));
  assert.equal(other.res.status, 404);
  assert.equal(other.fileHost, undefined);
  const apex = await registrationFile('https://example.com', fetcher({}));
  assert.equal(apex.res.status, 404);
  const ip = await registrationFile('http://127.0.0.1:8080', fetcher({}));
  assert.equal(ip.res.status, 404);
});
