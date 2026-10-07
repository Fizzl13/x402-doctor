'use strict';

// A small BOLT11 (Lightning invoice) decoder for the x402 `exact` scheme on `lnbtc`: currency, amount in
// millisatoshis, creation time, expiry, payment hash, description hash, payee and the key that signed it
// (recovered from the signature, so a forged `n` field or a wrong payTo shows up). Only what the checks need.
const { createHash } = require('node:crypto');
const { recoverPublicKey } = require('viem');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

// bech32 without the 90-character limit (invoices are longer). Returns { hrp, words } with the checksum removed.
function bech32Decode(str) {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('mixed case');
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new Error('no separator');
  const hrp = s.slice(0, pos);
  const words = [...s.slice(pos + 1)].map((c) => {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error(`invalid character "${c}"`);
    return v;
  });
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Error('bad checksum');
  return { hrp, words: words.slice(0, -6) };
}

function toBytes(words, pad) {
  let acc = 0, bits = 0;
  const out = [];
  for (const w of words) {
    acc = (acc << 5) | w; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  if (pad && bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Buffer.from(out);
}
const toInt = (words) => words.reduce((n, w) => n * 32 + w, 0);

// Amount in the human-readable part: BTC with an optional multiplier, returned in millisatoshis (BigInt).
const MULT_MSAT = { '': 100000000000n, m: 100000000n, u: 100000n, n: 100n };
function amountMsat(digits, mult) {
  if (!digits) return null;
  if (/^0\d/.test(digits)) throw new Error('amount has a leading zero');
  if (mult === 'p') {
    if (BigInt(digits) % 10n !== 0n) throw new Error('pico amount is not a whole millisatoshi');
    return BigInt(digits) / 10n;
  }
  return BigInt(digits) * MULT_MSAT[mult];
}

async function decode(invoice) {
  const { hrp, words } = bech32Decode(String(invoice).trim());
  const m = /^ln(bcrt|bc|tbs|tb|sb)(\d*)([munp]?)$/.exec(hrp);
  if (!m) throw new Error(`"${hrp}" is not a Lightning invoice prefix`);
  if (words.length < 7 + 104) throw new Error('too short');
  const data = words.slice(0, -104);
  const sigBytes = toBytes(words.slice(-104), false);
  const out = { currency: m[1], amountMsat: amountMsat(m[2], m[3]), timestamp: toInt(data.slice(0, 7)), expiry: 3600, paymentHash: null, descriptionHash: null, description: null, payee: null };
  let i = 7;
  while (i + 3 <= data.length) {
    const type = data[i];
    const len = data[i + 1] * 32 + data[i + 2];
    const field = data.slice(i + 3, i + 3 + len);
    i += 3 + len;
    if (type === 1 && len === 52) out.paymentHash = toBytes(field, false).toString('hex');
    else if (type === 23 && len === 52) out.descriptionHash = toBytes(field, false).toString('hex');
    else if (type === 19 && len === 53) out.payee = toBytes(field, false).toString('hex');
    else if (type === 6) out.expiry = toInt(field);
    else if (type === 13) out.description = toBytes(field, false).toString('utf8');
  }
  // Signature: 64 compact bytes plus the recovery id, over sha256(hrp bytes || data words as bytes, padded).
  const hash = createHash('sha256').update(Buffer.concat([Buffer.from(hrp, 'utf8'), toBytes(data, true)])).digest();
  const recid = sigBytes[64];
  if (recid > 3) throw new Error('bad recovery id');
  const uncompressed = await recoverPublicKey({ hash: `0x${hash.toString('hex')}`, signature: `0x${sigBytes.subarray(0, 64).toString('hex')}${(27 + recid).toString(16)}` });
  const xy = Buffer.from(uncompressed.slice(4), 'hex');
  out.signer = `${xy[63] % 2 ? '03' : '02'}${xy.subarray(0, 32).toString('hex')}`;
  return out;
}

module.exports = { decode, bech32Decode };
