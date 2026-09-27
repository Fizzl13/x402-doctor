// Signed verdicts: every paid answer (diagnose, preflight, fix; HTTP and MCP)
// carries a `receipt` signed by Doctor's published signer, so an agent can later
// prove which verdict it got for which endpoint (for example why it paid, or
// didn't pay, an x402 endpoint), not only that it paid Doctor.
//
// Same format as presign-guard (src/receipt.js there): EIP-191 personal_sign
// over canonical JSON of the whole answer without receipt.signature (profile
// js-json-stringify-sorted-utf16-ascii-v1: keys sorted by UTF-16 code units at
// every level, no whitespace, every code unit from U+007F up as lowercase
// \uXXXX, numbers as JSON.stringify writes them, UTF-8 bytes; Python's
// json.dumps matches only for ASCII keys and integers, see examples/canonical.py).
// The receipt holds a request id, the route, a SHA-256 of the request input,
// the time and the signer, so a verdict cannot be moved to another request or
// flipped without breaking the signature.
//
// The key comes from RECEIPT_SIGNER_SECRET (any long random string; Render
// generates it), hashed with a Doctor-specific label into a key that holds no
// funds. Without it, answers are unsigned, as before.

const { createHash, randomUUID } = require('node:crypto');
const { keccak256, stringToBytes, recoverMessageAddress, isAddress, getAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const ALGORITHM = 'EIP-191 personal_sign over canonical JSON of the response without receipt.signature';

function canonicalJson(value) {
  const ascii = (s) => JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v === undefined ? undefined : typeof v === 'string' ? ascii(v) : JSON.stringify(v);
    if (typeof v.toJSON === 'function') return walk(v.toJSON());
    if (Array.isArray(v)) return `[${v.map((x) => walk(x) ?? 'null').join(',')}]`;
    const parts = Object.keys(v).sort().flatMap((k) => {
      const inner = walk(v[k]);
      return inner === undefined ? [] : [`${ascii(k)}:${inner}`];
    });
    return `{${parts.join(',')}}`;
  };
  return walk(value);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const inputHash = (route, input) => sha256(canonicalJson({ route, input: input ?? {} }));

// The payment behind a paid answer (same as presign-guard's receipt.js), from
// the x402 payment payload: EVM EIP-3009 gives payer + nonce, so the settlement
// is the asset's AuthorizationUsed(payer, nonce) event; Solana gives the
// transfer authority and a SHA-256 of the signed transaction (the facilitator
// adds the fee-payer signature at settlement, so the final id is not known yet).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

// The transfer authority of a partially signed Solana transaction: signer #2
// after the facilitator's fee payer (x402 exact on Solana).
function svmPayer(base64Tx) {
  try {
    const b = Buffer.from(base64Tx, 'base64');
    let o = 0;
    const compact = () => { let v = 0, shift = 0, byte; do { byte = b[o++]; v |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80); return v; };
    const signatures = compact();
    o += 64 * signatures;
    if (b[o] & 0x80) o++; // versioned message prefix
    const required = b[o];
    o += 3; // header
    const keys = compact();
    if (required < 2 || keys < 2 || b.length < o + 64) return null;
    return base58(b.subarray(o + 32, o + 64));
  } catch {
    return null;
  }
}

function paymentOf(p) {
  if (!p || typeof p !== 'object') return null;
  const acc = p.accepted || p;
  const out = { network: acc.network ?? null, asset: acc.asset ?? null, amount: acc.amount ?? acc.maxAmountRequired ?? null, pay_to: acc.payTo ?? null };
  const auth = p.payload && p.payload.authorization;
  const tx = p.payload && p.payload.transaction;
  if (auth && auth.from && auth.nonce) return { ...out, amount: auth.value ?? out.amount, payer: auth.from, nonce: auth.nonce, proof: 'eip3009' };
  if (typeof tx === 'string') return { ...out, payer: svmPayer(tx), transaction_sha256: sha256(tx), proof: 'svm-transaction' };
  return out.network ? out : null;
}

function paymentFromHeaders(headers) {
  const raw = headers['payment-signature'] || headers['x-payment'];
  if (!raw) return null;
  try {
    return paymentOf(JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8')));
  } catch {
    return null;
  }
}

// Signer certificates (same as presign-guard): the payout wallet (AUTHORITY,
// the payTo of every payment) authorises a signing key with a personal_sign
// over certMessage. RECEIPT_SIGNER_CERT = "YYYY-MM-DD:0x<signature>", checked
// at startup and carried in every receipt, so clients that pin only the payout
// wallet verify a rotated key offline.
const AUTHORITY = '0x6B0F4651eD42893ab58139938175E4a69f175F25';
const SERVICE = 'x402-doctor';

function certMessage({ service, signer, valid_from: validFrom }) {
  return `fizzl receipt signer\nservice: ${service}\nsigner: ${signer}\nvalid_from: ${validFrom}`;
}

async function certValid(cert, { authority = AUTHORITY, service } = {}) {
  try {
    if (!cert || (service && cert.service !== service)) return false;
    if (String(cert.authority).toLowerCase() !== authority.toLowerCase()) return false;
    const recovered = await recoverMessageAddress({ message: certMessage(cert), signature: cert.signature });
    return recovered.toLowerCase() === authority.toLowerCase();
  } catch {
    return false;
  }
}

async function loadCert(env, service, signer) {
  const raw = String(env.RECEIPT_SIGNER_CERT || '').trim();
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(0x[0-9a-fA-F]{130})$/.exec(raw);
  const authority = isAddress(String(env.RECEIPT_AUTHORITY || '')) ? getAddress(env.RECEIPT_AUTHORITY) : AUTHORITY;
  const cert = m && { service, signer, valid_from: m[1], authority, signature: m[2] };
  if (!cert || !(await certValid(cert, { authority, service }))) {
    console.warn(`RECEIPT_SIGNER_CERT ignored: not a valid certificate by ${authority} for ${service} signer ${signer}`);
    return null;
  }
  return cert;
}

// RECEIPT_RETIRED_SIGNERS="0xabc…:2026-09-27/2026-12-01,…": old signers stay listed.
function retiredSigners(env) {
  return String(env.RECEIPT_RETIRED_SIGNERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address, range = ''] = entry.split(':');
      const [validFrom = null, validUntil = null] = range.split('/');
      return isAddress(address) ? { address: getAddress(address), valid_from: validFrom, valid_until: validUntil } : null;
    })
    .filter(Boolean);
}

function createSigner(env = process.env, { label = 'x402-doctor' } = {}) {
  const secret = String(env.RECEIPT_SIGNER_SECRET || '').trim();
  if (secret.length < 32) return null;
  const account = privateKeyToAccount(keccak256(stringToBytes(`${label} receipt signer v1:${secret}`)));
  const retired = retiredSigners(env);
  const certificate = loadCert(env, SERVICE, account.address);
  certificate.catch(() => {});
  return {
    address: account.address,
    certificate: () => certificate,
    signers: [{ address: account.address, status: 'current', valid_from: env.RECEIPT_SIGNER_SINCE || null, valid_until: null }, ...retired.map((r) => ({ ...r, status: 'retired' }))],
    async sign(body, { route, input, payment = null }) {
      const cert = await certificate;
      const receipt = {
        request_id: randomUUID(),
        route,
        input_sha256: inputHash(route, input),
        ...(payment && { payment }),
        ...(cert && { cert }),
        signed_at: new Date().toISOString(),
        signer: account.address,
        algorithm: 'eip191-canonical-json-v1',
      };
      const signature = await account.signMessage({ message: canonicalJson({ ...body, receipt }) });
      return { ...body, receipt: { ...receipt, signature } };
    },
  };
}

async function verifyReceipt(body, { signers = [], route, input, authority = AUTHORITY, service = SERVICE } = {}) {
  const r = body && body.receipt;
  if (!r || typeof r.signature !== 'string') return { valid: false, reason: 'no receipt.signature in the body' };
  const { signature, ...rest } = r;
  let recovered;
  try {
    recovered = await recoverMessageAddress({ message: canonicalJson({ ...body, receipt: rest }), signature });
  } catch (err) {
    return { valid: false, reason: `signature does not parse: ${err.message}` };
  }
  if (!r.signer || recovered.toLowerCase() !== String(r.signer).toLowerCase()) {
    return { valid: false, reason: 'signature does not match receipt.signer: the body or receipt was changed', recovered };
  }
  let known = signers.find((s) => s.address.toLowerCase() === recovered.toLowerCase());
  if (!known && r.cert && String(r.cert.signer).toLowerCase() === recovered.toLowerCase()
    && String(r.signed_at).slice(0, 10) >= r.cert.valid_from && (await certValid(r.cert, { authority, service }))) {
    known = { address: recovered, status: 'certified' };
  }
  const out = { valid: true, signer: recovered, known_signer: signers.length || r.cert ? Boolean(known) : null, signer_status: known ? known.status : null };
  if (route !== undefined && input !== undefined) out.input_matches = inputHash(route, input) === r.input_sha256;
  if ((signers.length || r.cert) && !known) return { ...out, valid: false, reason: 'signed, but not by an x402 Doctor signer' };
  if (out.input_matches === false) return { ...out, valid: false, reason: 'signed, but for a different request input' };
  return out;
}

// Express: sign 200 JSON answers on the paid routes (after the paywall).
function signPaidResponses(signer, paidRoutes) {
  const paid = new Set(paidRoutes);
  return (req, res, next) => {
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    if (!signer || !paid.has(route)) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return json(body);
      const input = req.method === 'GET' ? { ...req.query } : req.body;
      signer.sign(body, { route, input, payment: paymentFromHeaders(req.headers) }).then(json, (err) => {
        console.warn(`receipt signing failed on ${route}: ${err.message}`);
        json(body);
      });
      return res;
    };
    next();
  };
}

module.exports = { AUTHORITY, SERVICE, certMessage, certValid, loadCert, ALGORITHM, canonicalJson, sha256, inputHash, createSigner, verifyReceipt, signPaidResponses, paymentOf, paymentFromHeaders, svmPayer, base58 };
