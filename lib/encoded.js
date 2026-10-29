// Text hidden in an encoding an AI agent can read but a text filter may not: Morse code, base64 (and base64url), hex
// and 8-bit binary. In the Grok/Bankrbot drain of May 2026 a reply in Morse code carried the transfer order. Only
// decodings that read as words count, so hashes, keys, addresses and binary blobs are left alone. The same decoder
// as presign-guard's injection check (src/injection.js encodedOf), which found nothing in 36,273 real Bazaar
// listings on 29 Oct 2026.

const MAX_DECODED_CHARS = 4000;
const MORSE = {
  '.-': 'a', '-...': 'b', '-.-.': 'c', '-..': 'd', '.': 'e', '..-.': 'f', '--.': 'g', '....': 'h', '..': 'i', '.---': 'j',
  '-.-': 'k', '.-..': 'l', '--': 'm', '-.': 'n', '---': 'o', '.--.': 'p', '--.-': 'q', '.-.': 'r', '...': 's', '-': 't',
  '..-': 'u', '...-': 'v', '.--': 'w', '-..-': 'x', '-.--': 'y', '--..': 'z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
  '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'", '-.-.--': '!', '-..-.': '/', '-.--.': '(', '-.--.-': ')', '.-...': '&',
  '---...': ':', '-.-.-.': ';', '-...-': '=', '.-.-.': '+', '-....-': '-', '..--.-': '_', '.-..-.': '\"', '...-..-': '$', '.--.-.': '@',
};
const BASE64_RUN = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
const HEX_RUN = /\b[0-9a-fA-F]{2}(?:[ :]?[0-9a-fA-F]{2}){11,}\b/g;
const BINARY_RUN = /\b[01]{8}(?:\s+[01]{8}){5,}\b/g;

// Printable, two runs of three letters or more, and a space: words, not bytes.
function readable(t) {
  if (!t || t.includes('�')) return false;
  const printable = t.replace(/[^\x20-\x7E\n\t]/g, '').length;
  return printable / t.length >= 0.95 && (t.match(/[A-Za-z]{3,}/g) ?? []).length >= 2 && /[ \n]/.test(t.trim());
}

// Morse code: a run of at least six dot-dash codes, letters split by spaces and words by "/" (or two spaces or a
// line break). Dots and dashes may be written as ·, •, −, – or _.
function morseOf(text) {
  const norm = text.replace(/[·•∙]/g, '.').replace(/[−–—_]/g, '-');
  const found = [];
  let codes = [];
  const flush = () => {
    if (codes.filter((c) => c !== ' ').length >= 6) {
      const letters = codes.map((c) => (c === ' ' ? ' ' : MORSE[c] ?? '?'));
      const decoded = letters.join('').replace(/ +/g, ' ').trim();
      if (letters.filter((l) => l === '?').length <= codes.length * 0.1 && /[a-z0-9].*[a-z0-9].*[a-z0-9]/.test(decoded)) found.push(decoded);
    }
    codes = [];
  };
  for (const token of norm.replace(/\//g, ' / ').split(/( {2,}|\n|\s)/)) {
    if (!token || (/^\s$/.test(token) && token !== '\n')) continue;
    if (/^[.-]{1,8}$/.test(token)) codes.push(token);
    else if (token === '/' || /^( {2,}|\n)$/.test(token)) { if (codes.length && codes.at(-1) !== ' ') codes.push(' '); }
    else flush();
  }
  flush();
  return found;
}

// [{ encoding, decoded }], at most MAX_DECODED_CHARS of decoded text in all.
function encodedOf(text) {
  const out = [];
  const add = (encoding, decoded) => {
    decoded = decoded.trim();
    if (decoded && !out.some((e) => e.decoded === decoded)) out.push({ encoding, decoded });
  };
  for (const d of morseOf(text)) add('morse', d);
  const hexRuns = new Set();
  for (const m of text.matchAll(HEX_RUN)) {
    const hex = m[0].replace(/[ :]/g, '');
    hexRuns.add(hex);
    const d = Buffer.from(hex, 'hex').toString('utf8');
    if (readable(d)) add('hex', d);
  }
  for (const m of text.matchAll(BASE64_RUN)) {
    if (/^[0-9a-fA-F]+$/.test(m[0]) || hexRuns.has(m[0])) continue;
    const d = Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (readable(d)) add('base64', d);
  }
  for (const m of text.matchAll(BINARY_RUN)) {
    const d = m[0].split(/\s+/).map((b) => String.fromCharCode(parseInt(b, 2))).join('');
    if (readable(d)) add('binary', d);
  }
  let room = MAX_DECODED_CHARS;
  const kept = [];
  for (const e of out) {
    if (room <= 0) break;
    kept.push({ ...e, decoded: e.decoded.slice(0, room) });
    room -= e.decoded.length;
  }
  return kept;
}

module.exports = { encodedOf };
