// The seller's zero-knowledge proof (lib/concordium-proof.js), with the real proof the Concordium facilitator's demo
// seller serves (made in its owner's wallet on 6 Nov 2026). Concordium's verifier and wallet proxy are stand-ins that
// answer as the real ones did for this proof; everything around them is checked for real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkSellerProof, challengeFor, factsOf, PROOF_PATH } = require('../lib/concordium-proof');
const { checkConcordiumProof } = require('../lib/diagnose');

const TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
const ORIGIN = 'https://concordium-facilitator.onrender.com';
const URL_ = `${ORIGIN}/demo/paid`;
const PAY_TO = '3HFbRLEGSVUsebprTBmTvpdbTkHg4ncutEYWf4EEaQfgQae9v3';
const OTHER = '3acKWtGJQuFqoDgt16ghwvrcEVSQygj67fynVWaAKbmnEHaWeZ';
const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'concordium-proof.json'), 'utf8');
const FILE = JSON.parse(RAW);
const SUBJECT = FILE.presentation.verifiableCredential[0].credentialSubject;
const CRED = SUBJECT.id.split(':cred:')[1];
const NOW = Date.parse('2026-11-06T18:00:00Z');
// The account's encryption key: a 48-byte generator, then its first credential's registration id (as the testnet
// wallet proxy answered for 3HFb… on 6 Nov 2026).
const KEY = `b14cbfe44a02c6b1f78711176d5f437295367aa4f2a8c2551ee10d25a03adc69d61a332a058971919dad7312e1fc94c5${CRED}`;
const accepts = (payTo = PAY_TO) => [{ scheme: 'exact', network: TESTNET, amount: '1000', asset: 'CCD', payTo, extra: { feePayer: OTHER } }];

function world({ text = RAW, verifier = 200, key = KEY } = {}) {
  const calls = [];
  const safeFetch = async (u) => { calls.push(u); assert.ok(u.endsWith(PROOF_PATH)); return text === null ? { status: 404, text: '' } : { status: 200, text }; };
  const fetchImpl = async (u, init) => {
    calls.push(u);
    if (u.includes('web3id-verifier.testnet')) {
      const vp = JSON.parse(init.body);
      const body = verifier === 200 ? JSON.stringify({ block: 'b', blockTime: 't', challenge: vp.presentationContext, credentialStatements: [{ id: SUBJECT.id, statement: SUBJECT.statement }] }) : '"Invalid proof"';
      return { status: verifier, text: async () => body };
    }
    if (u.includes('/v0/accEncryptionKey/')) return { status: 200, json: async () => ({ accountEncryptionKey: u.endsWith(PAY_TO) ? key : 'aa'.repeat(96) }) };
    throw new Error(`unexpected ${u}`);
  };
  return { safeFetch, fetchImpl, calls };
}

test('the challenge ties the proof to network, site and payTo', () => {
  assert.equal(challengeFor('testnet', ORIGIN, PAY_TO), FILE.challenge);
  assert.notEqual(challengeFor('testnet', 'https://copycat.example', PAY_TO), FILE.challenge);
});

test('the demo seller: verified, an adult living in the EU, from the payTo account\'s own credential', async () => {
  const w = world();
  const r = await checkSellerProof(accepts(), { url: URL_, ...w, now: NOW });
  assert.deepEqual(r, { status: 'verified', network: 'testnet', payTo: PAY_TO, facts: ['adult', 'eu-residence'], issuer: 0, credential: CRED, created: '2026-11-06T16:17:59.762Z' });
  const checks = [];
  await checkConcordiumProof(accepts(), URL_, checks, w);
  assert.equal(checks[0].id, 'concordium-proof');
  assert.equal(checks[0].status, 'pass');
  assert.match(checks[0].message, /an adult \(18 or older\), lives in the EU/);
});

test('refused: a copycat site, a payTo the 402 doesn\'t offer, another account\'s credential, a failing proof, a relabelled presentation', async () => {
  assert.match((await checkSellerProof(accepts(), { url: 'https://copycat.example/paid', ...world(), now: NOW })).reason, /tied to/);
  assert.match((await checkSellerProof(accepts(OTHER), { url: URL_, ...world(), now: NOW })).reason, /doesn't offer/);
  assert.match((await checkSellerProof(accepts(), { url: URL_, ...world({ key: 'bb'.repeat(96) }), now: NOW })).reason, /not the payTo account's/);
  assert.match((await checkSellerProof(accepts(), { url: URL_, ...world({ verifier: 400 }), now: NOW })).reason, /does not verify/);
  const moved = JSON.parse(RAW); moved.presentation.presentationContext = challengeFor('testnet', 'https://elsewhere.example', PAY_TO);
  assert.match((await checkSellerProof(accepts(), { url: URL_, ...world({ text: JSON.stringify(moved) }), now: NOW })).reason, /not made for this site/);
  const checks = [];
  await checkConcordiumProof(accepts(), 'https://copycat.example/paid', checks, world());
  assert.deepEqual([checks[0].status, /concordium-proof\.html/.test(checks[0].hint)], ['warn', true]);
});

test('nothing to say: no proof served, or no Concordium payTo in the 402', async () => {
  assert.equal(await checkSellerProof(accepts(), { url: URL_, ...world({ text: null }) }), null);
  const w = world();
  assert.equal(await checkSellerProof([{ network: 'eip155:8453', payTo: '0x0000000000000000000000000000000000000001' }], { url: URL_, ...w }), null);
  assert.equal(w.calls.length, 0, 'nothing fetched for a non-Concordium 402');
  const checks = [];
  await checkConcordiumProof(accepts(), URL_, checks, world({ text: null }));
  assert.equal(checks.length, 0);
});

test('facts come from the verified statements only, as of now', () => {
  assert.deepEqual(factsOf(SUBJECT.statement, NOW), ['adult', 'eu-residence']);
  assert.deepEqual(factsOf([{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: '20120101' }], NOW), []);
  assert.deepEqual(factsOf([{ type: 'AttributeInSet', attributeTag: 'countryOfResidence', set: ['NL', 'US'] }], NOW), []);
  assert.deepEqual(factsOf([{ type: 'AttributeInSet', attributeTag: 'nationality', set: ['NL'] }], NOW), ['eu-nationality']);
});
