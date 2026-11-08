'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createExamForward, examPrefix } = require('../lib/exam-forward');

const ORIGIN = 'https://exam.fizzl.eu';
const EXAM = `${ORIGIN}/e/${'a'.repeat(24)}/t3`;

test('examPrefix: only addresses of an exam sitting and task', () => {
  assert.equal(examPrefix(`${EXAM}/s-1a2b3c4d/v1/price?x=1`, ORIGIN), EXAM);
  assert.equal(examPrefix('https://api.example.com/v1/price', ORIGIN), null);
  assert.equal(examPrefix(`${ORIGIN}/v1/index`, ORIGIN), null);
  assert.equal(examPrefix(`https://exam.fizzl.eu.evil.example/e/${'a'.repeat(24)}/t3/x`, ORIGIN), null);
});

async function serve(forward) {
  const app = express();
  app.use(express.json());
  app.use(forward);
  app.get('/api/v1/preflight', (_req, res) => res.json({ verdict: 'from-doctor' }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  test.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('a preflight for an exam address goes to the exam, signed on 200; a 402 comes back as it is; others stay', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.headers['payment-signature']) return new Response(JSON.stringify({ verdict: 'go' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ x402Version: 2 }), { status: 402, headers: { 'content-type': 'application/json', 'payment-required': 'e30=' } });
  };
  const signer = { sign: async (body) => ({ ...body, receipt: { signed: true } }) };
  const base = await serve(createExamForward({ origin: ORIGIN, signer, fetchImpl }));
  const target = encodeURIComponent(`${EXAM}/s-1a2b3c4d/v1/price`);

  const challenge = await fetch(`${base}/api/v1/preflight?url=${target}&max_usd=0.05`);
  assert.equal(challenge.status, 402);
  assert.equal(challenge.headers.get('payment-required'), 'e30=');
  assert.equal(calls[0].url, `${EXAM}/x402-doctor.fizzl.eu/api/v1/preflight?url=${target}&max_usd=0.05`);

  const paid = await fetch(`${base}/api/v1/preflight?url=${target}`, { headers: { 'payment-signature': 'abc' } });
  assert.equal(paid.status, 200);
  assert.deepEqual(await paid.json(), { verdict: 'go', receipt: { signed: true } });
  assert.equal(calls[1].init.headers['payment-signature'], 'abc');

  const real = await fetch(`${base}/api/v1/preflight?url=${encodeURIComponent('https://api.example.com/paid')}`);
  assert.deepEqual(await real.json(), { verdict: 'from-doctor' });
  assert.equal(calls.length, 2);
});

test('an outcome report about an exam address goes to the exam too', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    return new Response(JSON.stringify({ recorded: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const base = await serve(createExamForward({ origin: ORIGIN, fetchImpl }));
  const r = await fetch(`${base}/api/v1/outcome`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${EXAM}/s-1a2b3c4d/v1/price`, outcome: 'refused', reason: 'price_changed' }) });
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, `${EXAM}/x402-doctor.fizzl.eu/api/v1/outcome`);
  assert.equal(JSON.parse(calls[0].body).reason, 'price_changed');
});
