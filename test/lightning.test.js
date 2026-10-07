// Bitcoin Lightning (x402 "exact" on lnbtc): BOLT11 decoding against the spec's test vector, the request hash
// (http:1 and mcp:1 vectors), the option's fields and the invoice-to-option match, also via a full diagnose.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { sign } = require('viem/accounts');
const { decode } = require('../lib/bolt11');
const { httpRequestHash, jcs, checkLightning } = require('../lib/lightning');
const { checkAccepts, diagnose } = require('../lib/diagnose');
const { NETWORKS, familyOf } = require('../lib/networks');
const { createSafeFetch } = require('../lib/safe-fetch');

const LN = 'lnbtc:000000000019d6689c085ae165831e93';
const VECTOR = 'lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f';
const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'; // the key of private key 1
const VECTOR_HASH = '0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018';
const sha = (b) => createHash('sha256').update(b).digest();

// A minimal BOLT11 encoder for the tests (p, h and x fields, signed with private key 1).
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(v) { let c = 1; for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= GEN[i]; } return c >>> 0; }
const expand = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function toWords(bytes) { let acc = 0, bits = 0; const out = []; for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } } if (bits) out.push((acc << (5 - bits)) & 31); return out; }
function toBytes(words) { let acc = 0, bits = 0; const out = []; for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } } if (bits) out.push((acc << (8 - bits)) & 255); return Buffer.from(out); }
const intWords = (n, len) => Array.from({ length: len }, (_, i) => Math.floor(n / 32 ** (len - 1 - i)) % 32);
const tag = (type, words) => [type, words.length >> 5, words.length & 31, ...words];
async function invoice({ hrp = 'lnbc250n', timestamp, expiry = 300, descriptionHash, key = '0x' + '00'.repeat(31) + '01' }) {
  const data = [...intWords(timestamp, 7), ...tag(1, toWords(sha(Buffer.from(String(Math.random()))))), ...tag(23, toWords(Buffer.from(descriptionHash, 'hex'))), ...tag(6, intWords(expiry, 2))];
  const hash = sha(Buffer.concat([Buffer.from(hrp), toBytes(data)]));
  const sig = await sign({ hash: `0x${hash.toString('hex')}`, privateKey: key });
  const words = [...data, ...toWords(Buffer.concat([Buffer.from(sig.r.slice(2).padStart(64, '0'), 'hex'), Buffer.from(sig.s.slice(2).padStart(64, '0'), 'hex'), Buffer.from([sig.yParity])]))];
  const mod = polymod([...expand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  return `${hrp}1${[...words, ...intWords(mod, 6)].map((w) => CHARSET[w]).join('')}`;
}

const option = (extra = {}, over = {}) => ({ scheme: 'exact', network: LN, amount: '25000', asset: 'BTC', payTo: G, maxTimeoutSeconds: 300, extra: { paymentFlow: 'upfront', requestHash: VECTOR_HASH, requestBindingProfile: 'http:1', requestBindingParams: { headers: [] }, invoice: VECTOR, ...extra }, ...over });
const addCheck = (checks, id, status, message, extra = {}) => checks.push({ id, status, message, ...extra });

test('decodes the spec test vector: amount, expiry, description hash and the signing key', async () => {
  const d = await decode(VECTOR);
  assert.equal(d.currency, 'bc');
  assert.equal(d.amountMsat, 25000n);
  assert.equal(d.timestamp, 1700000000);
  assert.equal(d.expiry, 300);
  assert.equal(d.descriptionHash, VECTOR_HASH);
  assert.equal(d.signer, G);
  await assert.rejects(decode(VECTOR.slice(0, -1) + (VECTOR.endsWith('f') ? 'g' : 'f')), /checksum/);
});

test('request hash: the spec vectors for http:1 and mcp:1', () => {
  assert.equal(httpRequestHash({ method: 'GET', url: 'https://api.example.com/article/A' }, []), VECTOR_HASH);
  assert.notEqual(httpRequestHash({ method: 'GET', url: 'https://api.example.com/article/B' }, []), VECTOR_HASH);
  assert.equal(jcs({ b: [1, 'x'], a: { d: 'é', c: '' } }), '{"a":{"c":"","d":"é"},"b":[1,"x"]}');
  const mcp = createHash('sha256').update(jcs({ domain: 'x402:exact:lnbtc:bolt11:mcp:1', server: 'https://other.example.com/mcp', method: 'tools/call', name: 'get_article', arguments: { article: 'A' }, metadata: [] })).digest('hex');
  assert.equal(mcp, '96903c29186c6aabc95e48abafd8ce3ad32b4060f5d5bf22cf75f3fbfe816e45');
});

test('networks: lnbtc mainnet and testnet are known, family lightning', () => {
  assert.equal(familyOf(LN), 'lightning');
  assert.equal(NETWORKS[LN].bolt11, 'bc');
  assert.equal(familyOf('lnbtc:000000000933ea01ad0ee984209779ba'), 'lightning');
});

test('checkAccepts: a spec-shaped option passes; wrong flow, asset, amount, payTo and binding fail', () => {
  const ok = [];
  checkAccepts([option()], ok);
  assert.deepEqual(ok.filter((c) => c.status !== 'pass').map((c) => `${c.id} ${c.message}`), []);
  const bad = [];
  checkAccepts([option({ paymentFlow: 'deferred', requestBindingParams: { headers: ['b', 'a'] } }, { asset: 'SAT', amount: '25.5', payTo: G.toUpperCase() })], bad);
  const by = Object.fromEntries(bad.map((c) => [c.id, c]));
  assert.equal(by['accepts[0]-payto'].status, 'fail');
  assert.equal(by['accepts[0]-asset'].status, 'fail');
  assert.equal(by['accepts[0]-amount'].status, 'fail');
  assert.equal(by['accepts[0]-lightning'].status, 'fail');
  assert.match(by['accepts[0]-lightning'].message, /upfront/);
  assert.match(by['accepts[0]-lightning'].message, /sorted/);
});

test('checkLightning: the vector matches its option at its own time; mismatches and expiry fail', async () => {
  const at = 1700000000 * 1000;
  const pass = [];
  await checkLightning([option()], pass, { networks: NETWORKS, addCheck, now: at, request: { method: 'GET', url: 'https://api.example.com/article/A' } });
  assert.deepEqual(pass.map((c) => `${c.id}:${c.status}`), ['lightning-invoice:pass', 'lightning-request-hash:pass']);
  const fail = [];
  await checkLightning([option({}, { amount: '26000', maxTimeoutSeconds: 600, payTo: '03' + G.slice(2) })], fail, { networks: NETWORKS, addCheck, now: at });
  assert.equal(fail[0].status, 'fail');
  for (const re of [/amount is 25000 msat/, /expiry is 300/, /not by payTo/]) assert.match(fail[0].message, re);
  const expired = [];
  await checkLightning([option()], expired, { networks: NETWORKS, addCheck, now: at + 301000 });
  assert.match(expired[0].message, /expired 1 s ago/);
  const wrongUrl = [];
  await checkLightning([option()], wrongUrl, { networks: NETWORKS, addCheck, now: at, request: { method: 'GET', url: 'https://api.example.com/article/B' } });
  assert.equal(wrongUrl[1].status, 'fail');
  const garbage = [];
  await checkLightning([option({ invoice: 'lnbc1notaninvoice' })], garbage, { networks: NETWORKS, addCheck, now: at });
  assert.equal(garbage[0].status, 'fail');
});

test('diagnose: a live endpoint with a fresh, correctly bound invoice passes the Lightning checks', async () => {
  let base;
  const server = http.createServer(async (req, res) => {
    const url = `${base}${req.url}`;
    const requestHash = httpRequestHash({ method: req.method, url }, []);
    const accepts = [option({ requestHash, invoice: await invoice({ timestamp: Math.floor(Date.now() / 1000), descriptionHash: requestHash }) })];
    const challenge = { x402Version: 2, error: 'Payment required', resource: { url, description: 'A test article', mimeType: 'application/json' }, accepts };
    res.writeHead(402, { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await diagnose(`${base}/article/A`, { safeFetch: createSafeFetch({ allowPrivate: true }), method: 'GET' });
    const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(by['lightning-invoice']?.status, 'pass', JSON.stringify(by['lightning-invoice']));
    assert.equal(by['lightning-request-hash']?.status, 'pass', JSON.stringify(by['lightning-request-hash']));
    assert.equal(by['accepts[0]-lightning'].status, 'pass');
  } finally { server.close(); }
});

test('wallets: Lightning agents pay a matching lnbtc option, nobody when the invoice fails', () => {
  const { walletCompatibility } = require('../lib/wallets');
  assert.deepEqual(walletCompatibility([option()], []).filter((w) => w.yes.length).map((w) => w.wallet), ['x402 Lightning agents']);
  const blocked = walletCompatibility([option()], [{ id: 'lightning-invoice', status: 'fail', option: 0 }]);
  assert.ok(blocked.every((w) => w.yes.length === 0));
});

test('preflight: a Lightning option with an invoice for another node is not payable', async () => {
  const { preflight } = require('../lib/preflight');
  let base;
  const server = http.createServer(async (req, res) => {
    const url = `${base}${req.url}`;
    const requestHash = httpRequestHash({ method: req.method, url }, []);
    const wrongNode = '03' + G.slice(2); // the invoice is signed by key 1, payTo says another node
    const accepts = [option({ requestHash, invoice: await invoice({ timestamp: Math.floor(Date.now() / 1000), descriptionHash: requestHash }) }, { payTo: wrongNode })];
    const challenge = { x402Version: 2, error: 'Payment required', resource: { url, description: 'A test article', mimeType: 'application/json' }, accepts };
    res.writeHead(402, { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') });
    res.end(JSON.stringify(challenge));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await preflight(`${base}/article/A`, { safeFetch: createSafeFetch({ allowPrivate: true }), method: 'GET' });
    const opt = report.options[0];
    assert.equal(opt.payable, false);
    assert.match(opt.problems.join(' '), /not by payTo/);
    assert.notEqual(report.verdict, 'go');
  } finally { server.close(); }
});
