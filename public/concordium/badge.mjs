// A Concordium badge in its short form (the CIS-2 token address the badge check and agent cards use), from what an
// owner pastes: the short form itself, the card's "ccd:<genesis>/cis-2:<address>" form, or the "Agent ID" that
// Concordium's registry app shows. That Agent ID is the same Base58Check token address with the contract index,
// subindex and token id as fixed 8-byte numbers; the short form has the index and subindex as LEB128 and the token id
// as its 8 bytes (CIS-8004 token ids are u64).
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decode58(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return new Uint8Array(bytes);
}
function encode58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = `1${s}`; }
  return s;
}
async function checksum(body) {
  const once = await crypto.subtle.digest('SHA-256', body);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', once)).slice(0, 4);
}
const u64 = (b, at) => b.slice(at, at + 8).reduceRight((n, x) => n * 256n + BigInt(x), 0n);
function leb128(n) {
  const out = [];
  do { let x = Number(n & 0x7fn); n >>= 7n; if (n) x |= 0x80; out.push(x); } while (n);
  return out;
}

export async function normalizeBadge(input) {
  const text = String(input || '').trim().replace(/^ccd:[0-9a-f]+\/cis-2:/i, '');
  if (!text) throw new Error('Fill in the badge first: the CIS-2 token address of your agent, or the Agent ID that Concordium\'s registry shows for it.');
  const raw = decode58(text);
  if (!raw || raw.length < 6) throw new Error('That is not a badge: expected a Base58 token address such as Mf22oVsbu3vf4Jb1cga49.');
  const body = raw.slice(0, -4);
  const sum = await checksum(body);
  if (sum.some((b, i) => b !== raw[raw.length - 4 + i])) throw new Error('That badge has a typo: its checksum does not match.');
  if (body[0] !== 2) throw new Error('That is not a CIS-2 token address.');
  if (body.length !== 25) return text; // already the short form
  const short = Uint8Array.from([2, ...leb128(u64(body, 1)), ...leb128(u64(body, 9)), ...body.slice(17, 25)]);
  return encode58(Uint8Array.from([...short, ...(await checksum(short))]));
}
