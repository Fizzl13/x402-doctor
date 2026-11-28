'use strict';
// An Algorand or Stellar payTo bound to a Concordium account with CIS-8 (lib/concordium-ed25519-key.js): the key read
// from the address, the canonical bytes checked and signed on the owner's own computer (public/concordium/cis8-sign.mjs),
// the signature checked before the registerExternalKey transaction is built, and Doctor's payee check counting a payTo
// whose own key is bound to the agent's owner.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bindStep, payToBinding, ed25519KeyOf, addressOfEd25519, namespacesFor } = require('../lib/concordium-ed25519-key');
const { isAlgorandAddress, isStellarAddress } = require('../lib/networks');
const { verifyConcordiumPayees, clearConcordiumCache } = require('../lib/concordium-agent');

const SCRIPT = path.join(__dirname, '..', 'public', 'concordium', 'cis8-sign.mjs');
const ALGO = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const ACCOUNT = '3kBx2h5Y2veb4hZgAJWPrr8RyQESKm5TjzF3ti1QQ4VSYLwK1G';
const MAINNET_GENESIS = '9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478';

// Test keys made here (never real accounts): the seed, its ed25519 public key, and the secret as each chain writes it.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (bytes) => { let bits = 0, acc = 0, o = ''; for (const b of bytes) { acc = ((acc << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { bits -= 5; o += B32[(acc >> bits) & 31]; } } if (bits) o += B32[(acc << (5 - bits)) & 31]; return o; };
const crc = (bytes) => { let c = 0; for (const b of bytes) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; };
const pubOf = (seed) => crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32);
const stellarSecret = (seed) => { const body = Buffer.concat([Buffer.from([18 << 3]), seed]); const c = crc(body); return b32(Buffer.concat([body, Buffer.from([c & 255, c >> 8])])); };
const src = require('node:fs').readFileSync(SCRIPT, 'utf8');
const WORDS = src.slice(src.indexOf('const WORDS = (') + 15, src.indexOf(").trim().split(' ');")).replace(/'\s*\+?\s*/g, '').replace(/\s+/g, ' ').trim().split(' ');
const u11 = (bytes) => { const o = []; let a = 0, b = 0; for (const x of bytes) { a |= x << b; b += 8; if (b >= 11) { o.push(a & 0x7ff); a >>= 11; b -= 11; } } if (b) o.push(a); return o; };
const algorandMnemonic = (seed) => [...u11(seed).map((i) => WORDS[i]), WORDS[u11(crypto.createHash('sha512-256').update(seed).digest())[0]]].join(' ');
const sign = (seed, bytes) => crypto.sign(null, bytes, crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })).toString('hex');

// The canonical bytes as Concordium's build_cis8_canonical_bytes lays them out.
function canonical(namespace, keyHex, { account = crypto.randomBytes(32), genesis = MAINNET_GENESIS } = {}) {
  const str = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const key = Buffer.from(keyHex, 'hex');
  const klen = Buffer.alloc(4); klen.writeUInt32LE(key.length);
  return Buffer.concat([Buffer.from('CIS-8/v1/canonical'), account, u64(10081), u64(0), Buffer.from(genesis, 'hex'), str(namespace), str(namespace), str('ed25519'), klen, key, str('solana-ed25519')]);
}
// Concordium's registry service, answered from `tools` (a value or a function of the arguments).
const registry = (tools) => {
  const calls = [];
  const call = async (name, args) => { calls.push({ name, args }); const v = tools[name]; return typeof v === 'function' ? v(args) : v ?? null; };
  return { call, calls };
};

test('the BIP-39 list in the script is the real one, and the zero key gives the known vectors', () => {
  assert.equal(WORDS.length, 2048);
  assert.equal(crypto.createHash('sha256').update(`${WORDS.join('\n')}\n`).digest('hex'), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
  assert.equal(algorandMnemonic(Buffer.alloc(32)), `${'abandon '.repeat(24)}invest`);
  assert.equal(addressOfEd25519('algorand:mainnet', '00'.repeat(32)), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ');
});

test('the key is read from an Algorand or Stellar address, and back', () => {
  const seed = crypto.randomBytes(32), hex = pubOf(seed).toString('hex');
  const algo = addressOfEd25519(ALGO, hex), xlm = addressOfEd25519('stellar:pubnet', hex);
  assert.ok(isAlgorandAddress(algo) && isStellarAddress(xlm, 'G'), 'Doctor\'s own address checks accept both');
  assert.equal(ed25519KeyOf(ALGO, algo), hex);
  assert.equal(ed25519KeyOf('stellar:pubnet', xlm), hex);
  assert.equal(ed25519KeyOf('stellar:pubnet', algo), null, 'an Algorand address on Stellar is no key');
  assert.equal(ed25519KeyOf('eip155:8453', '0x' + '11'.repeat(20)), null);
  assert.deepEqual(namespacesFor(ALGO), ['algorand:mainnet', ALGO]);
  assert.deepEqual(namespacesFor('stellar:testnet'), ['stellar:testnet']);
});

test('bindStep: the bytes to sign, then the signature checked and registerExternalKey built', async () => {
  const seed = crypto.randomBytes(32), hex = pubOf(seed).toString('hex');
  const payTo = addressOfEd25519('stellar:pubnet', hex);
  const bytes = canonical('stellar:pubnet', hex);
  const r = registry({
    owner_of_key: null,
    build_cis8_canonical_bytes: { bytes_hex: bytes.toString('hex') },
    build_cis8_register: (a) => ({ contract_address: { index: 10081, subindex: 0 }, receive_name: 'CIS-8.registerExternalKey', parameter_hex: 'abcd', suggested_energy: 30000, echo: a }),
  });
  const one = await bindStep({ network: 'mainnet', account: ACCOUNT, payNetwork: 'stellar:pubnet', payTo }, { call: r.call });
  assert.equal(one.status, 200);
  assert.equal(one.body.bytes_hex, bytes.toString('hex'));
  assert.deepEqual(one.body.key, { namespace: 'stellar:pubnet', key_type: 'ed25519', public_key_hex: hex });
  assert.match(one.body.sign, new RegExp(`^node cis8-sign\\.mjs ${payTo} [0-9a-f]+$`));
  const asked = r.calls.find((c) => c.name === 'build_cis8_canonical_bytes').args;
  assert.deepEqual([asked.concordium_account, asked.external_namespace, asked.proof_scheme], [ACCOUNT, 'stellar:pubnet', 'solana-ed25519']);

  const two = await bindStep({ network: 'mainnet', account: ACCOUNT, payNetwork: 'stellar:pubnet', payTo, signature: sign(seed, bytes) }, { call: r.call });
  assert.equal(two.status, 200, JSON.stringify(two.body));
  assert.equal(two.body.tx.receive_name, 'CIS-8.registerExternalKey');
  assert.equal(two.body.tx.parameter_hex, 'abcd');
  const built = r.calls.find((c) => c.name === 'build_cis8_register').args;
  assert.deepEqual(built.proof, { scheme: 'solana-ed25519', signature_hex: sign(seed, bytes) });

  const wrong = await bindStep({ network: 'mainnet', account: ACCOUNT, payNetwork: 'stellar:pubnet', payTo, signature: sign(crypto.randomBytes(32), bytes) }, { call: r.call });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /not .*'s over these bytes/);
});

test('bindStep: what it refuses, and a key already bound', async () => {
  const hex = pubOf(crypto.randomBytes(32)).toString('hex');
  const algo = addressOfEd25519(ALGO, hex);
  const r = registry({ owner_of_key: (a) => (a.external_key.namespace === 'algorand:mainnet' ? { owner_account: ACCOUNT, status: 'Active' } : null) });
  assert.match((await bindStep({ network: 'devnet', account: ACCOUNT, payNetwork: ALGO, payTo: algo }, { call: r.call })).body.error, /testnet or mainnet/);
  assert.match((await bindStep({ network: 'mainnet', account: 'x', payNetwork: ALGO, payTo: algo }, { call: r.call })).body.error, /account/);
  assert.match((await bindStep({ network: 'mainnet', account: ACCOUNT, payNetwork: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payTo: algo }, { call: r.call })).body.error, /Solana wallets sign raw bytes/);
  assert.match((await bindStep({ network: 'testnet', account: ACCOUNT, payNetwork: ALGO, payTo: algo }, { call: r.call })).body.error, /mainnet payTo binds on Concordium mainnet/);
  assert.match((await bindStep({ network: 'mainnet', account: ACCOUNT, payNetwork: 'stellar:pubnet', payTo: algo }, { call: r.call })).body.error, /Stellar account/);
  const done = await bindStep({ network: 'mainnet', account: ACCOUNT, payNetwork: ALGO, payTo: algo }, { call: r.call });
  assert.deepEqual([done.body.bound, done.body.done, done.body.account], [true, true, ACCOUNT]);
  // Bytes that don't name the key are not passed on to be signed.
  const odd = registry({ owner_of_key: null, build_cis8_canonical_bytes: { bytes_hex: canonical('algorand:mainnet', '22'.repeat(32)).toString('hex') } });
  assert.equal((await bindStep({ network: 'mainnet', account: ACCOUNT, payNetwork: ALGO, payTo: algo }, { call: odd.call })).status, 502);
});

test('cis8-sign.mjs signs only CIS-8 bytes for the payTo given, with that payTo\'s own key (Stellar and Algorand)', () => {
  const run = (args, input) => {
    try { return { out: execFileSync(process.execPath, [SCRIPT, ...args], { input: `${input}\n`, stdio: ['pipe', 'pipe', 'pipe'] }).toString() }; } catch (err) { return { err: err.stderr.toString() }; }
  };
  for (const [ns, secretOf] of [['stellar:pubnet', stellarSecret], ['algorand:mainnet', algorandMnemonic]]) {
    const seed = crypto.randomBytes(32), hex = pubOf(seed).toString('hex');
    const payTo = addressOfEd25519(ns, hex);
    const bytes = canonical(ns, hex);
    const ok = run([payTo, bytes.toString('hex')], secretOf(seed));
    assert.ok(ok.out, ok.err);
    assert.match(ok.out, new RegExp(`bind ${payTo} \\(${ns}\\) to Concordium account \\S+ on mainnet, CIS-8 contract <10081,0>`));
    const sig = ok.out.trim().split('\n').pop();
    assert.equal(sig, sign(seed, bytes), `${ns}: the raw ed25519 signature`);
    assert.ok(!ok.out.includes(secretOf(seed).split(' ')[0] + (ns.startsWith('stellar') ? '' : ' ')), 'the secret is not echoed');
    assert.match(run([payTo, bytes.toString('hex')], secretOf(crypto.randomBytes(32))).err, /this secret is the key of .*nothing signed/);
  }
  const seed = crypto.randomBytes(32), hex = pubOf(seed).toString('hex');
  const xlm = addressOfEd25519('stellar:pubnet', hex);
  assert.match(run([xlm, '54580000'], stellarSecret(seed)).err, /not CIS-8 canonical bytes/, 'an Algorand transaction ("TX"…) is refused');
  assert.match(run([xlm, Buffer.concat([canonical('stellar:pubnet', hex), Buffer.from([1])]).toString('hex')], stellarSecret(seed)).err, /more than a CIS-8 binding/);
  assert.match(run([addressOfEd25519('stellar:pubnet', '33'.repeat(32)), canonical('stellar:pubnet', hex).toString('hex')], stellarSecret(seed)).err, /the bytes bind/);
  const typo = stellarSecret(seed).slice(0, -1) + (stellarSecret(seed).endsWith('A') ? 'B' : 'A');
  assert.match(run([xlm, canonical('stellar:pubnet', hex).toString('hex')], typo).err, /checksum/);
});

test('payTo check: an Algorand payTo whose own key CIS-8 binds to the agent\'s owner is the agent\'s', async () => {
  const OWNER = '3dt3UMPzRASZndjmKpSWgCP2HhmoxZrgs8FDPtZjNHZzj13hhB';
  const SELLER = 'https://seller.example', CARD_URL = `${SELLER}/.well-known/agent-card.json`;
  const BADGE = 'JyP9TtQC3HCNrTYR3sc2T', TESTNET = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';
  const text = JSON.stringify({ name: 'Seller', url: SELLER, capabilities: { extensions: [{ uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1', params: { tokenAddress: `${TESTNET}/cis-2:${BADGE}` } }] } });
  const mine = pubOf(crypto.randomBytes(32)).toString('hex'), theirs = pubOf(crypto.randomBytes(32)).toString('hex');
  const agentRow = (extra = {}) => ({ token_id: '0', owner_account: OWNER, agent_uri: CARD_URL, metadata_hash_hex: crypto.createHash('sha256').update(text).digest('hex'), status: 'Active', ...extra });
  const tools = (extra) => ({
    agent_by_token_address: agentRow(extra),
    owner_of_key: (a) => (a.external_key.public_key_hex === mine ? { owner_account: OWNER, status: 'Active' } : a.external_key.public_key_hex === theirs ? { owner_account: '4Ft9oKbZ4pYCSgWjNiwr1Q2ypCzD9ZDyxfi3oUqE2ZTNQtXwrb', status: 'Active' } : null),
  });
  const fetchImpl = (t) => async (_url, init) => {
    const { params } = JSON.parse(init.body);
    const v = typeof t[params.name] === 'function' ? t[params.name](params.arguments) : t[params.name];
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(v ?? null) }] } }) };
  };
  const safeFetch = async (url) => (url === CARD_URL ? { status: 200, text } : { status: 404, text: '' });
  const accepts = [
    { network: ALGO, payTo: addressOfEd25519(ALGO, mine) },
    { network: 'stellar:pubnet', payTo: addressOfEd25519('stellar:pubnet', theirs) },
    { network: 'stellar:pubnet', payTo: addressOfEd25519('stellar:pubnet', '44'.repeat(32)) },
  ];
  clearConcordiumCache();
  const out = await verifyConcordiumPayees(accepts, { url: SELLER, safeFetch, fetchImpl: fetchImpl(tools()) });
  assert.deepEqual(out.results.map((x) => x.outcome), ['verified-external-key', 'mismatch', 'not-bound']);
  assert.match(out.results[0].reason, /own key is bound with CIS-8 \(algorand:mainnet\) to the agent's owner/);
  assert.match(out.results[1].reason, /bound with CIS-8 to 4Ft9/);

  // The agent names an Algorand key (setExternalReference): its payTo is compared as an Algorand address.
  clearConcordiumCache();
  const named = await verifyConcordiumPayees(accepts.slice(0, 1), { url: SELLER, safeFetch, fetchImpl: fetchImpl(tools({ external_reference: { kind: 'Cis8', key: { namespace: 'algorand:mainnet', key_type: 'ed25519', public_key_hex: mine } } })) });
  assert.equal(named.results[0].outcome, 'verified-external-key');
  assert.equal(named.results[0].reason, undefined, 'matched by the named key, not by a second lookup');
});

test('payToBinding: not-read when the registry is down, never a pass', async () => {
  const hex = pubOf(crypto.randomBytes(32)).toString('hex');
  const out = await payToBinding('mainnet', 'stellar:pubnet', addressOfEd25519('stellar:pubnet', hex), { call: async () => { throw new Error('HTTP 503'); } });
  assert.equal(out.bound, null);
  assert.match(out.reason, /503/);
});

test('the page, the script, the CIS-8 schema and the route are served', async () => {
  const { createApp } = require('../server');
  const trustIndex = { lookup: async () => null, refresh: () => Promise.resolve(), summary: () => null };
  const app = createApp({ allowPrivate: true, env: {}, trustIndex });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/concordium-payto.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /cis8-sign\.mjs[\s\S]*registerExternalKey/);
    const script = await fetch(`${base}/concordium/cis8-sign.mjs`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    const schema = Buffer.from((await (await fetch(`${base}/concordium/cis8-schema.b64`)).text()).trim(), 'base64');
    assert.equal(schema.subarray(0, 3).toString('hex'), 'ffff03', 'a versioned module schema');
    assert.ok(schema.includes(Buffer.from('registerExternalKey')) && schema.includes(Buffer.from('public_key')));
    const bad = await fetch(`${base}/api/v1/concordium/payto-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'mainnet' }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /account/);
  } finally {
    server.close();
  }
});
