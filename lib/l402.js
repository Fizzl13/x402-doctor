// L402 (Lightning Labs, formerly LSAT): HTTP 402 paid in bitcoin over Lightning.
// A 402 carries `WWW-Authenticate: L402 macaroon="<base64>", invoice="<BOLT 11>"`
// (servers should also send the same challenge as `LSAT`, first, for older
// clients). The client pays the invoice, gets the preimage, and retries with
// `Authorization: L402 <macaroon>:<hex preimage>`; a wrong credential gets 401.
// Spec: https://github.com/lightninglabs/L402. These checks read the challenge
// and decode the invoice only; nothing is paid.
const { parseAuthParams, headerValue } = require('./mpp');

const addCheck = (checks, id, status, message, extra = {}) => checks.push({ id, status, message, group: 'l402', ...extra });

// Where each L402 / LSAT challenge starts in a (possibly merged) WWW-Authenticate value.
function schemeStarts(header) {
  const starts = [];
  const re = /(?:^|,)\s*(L402|LSAT)\s+(?=[A-Za-z0-9_-]+\s*=)/gi;
  let m;
  while ((m = re.exec(header))) starts.push({ at: m.index + m[0].indexOf(m[1]), scheme: m[1].toUpperCase() });
  return starts;
}

// [{ scheme, params, error }] for every L402/LSAT challenge in the header.
function parseL402(header) {
  const starts = schemeStarts(String(header || ''));
  return starts.map(({ at, scheme }, n) => {
    const end = n + 1 < starts.length ? starts[n + 1].at : header.length;
    try {
      const params = parseAuthParams(header.slice(at + scheme.length, end).replace(/,\s*$/, ''));
      // Some servers name the macaroon "token" (newer drafts); read either.
      if (!params.macaroon && params.token) params.macaroon = params.token;
      return { scheme, params };
    } catch (err) {
      return { scheme, params: {}, error: err.message };
    }
  });
}

const hasL402 = (headers) => schemeStarts(String(headerValue(headers, 'www-authenticate') || '')).length > 0;

// ---- BOLT 11 (just enough to price and date an invoice) ----
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
const NETWORKS = { bc: 'bitcoin', tb: 'testnet', tbs: 'signet', bcrt: 'regtest' };
const MSAT_PER = { '': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };

// { network, msat (BigInt|null), timestamp, expiry, expiresAt } or throws.
function decodeBolt11(invoice) {
  const s = String(invoice || '').trim().toLowerCase().replace(/^lightning:/, '');
  if (s.length < 100 || s.length > 7089) throw new Error('not a BOLT 11 invoice (wrong length)');
  const sep = s.lastIndexOf('1');
  const hrp = s.slice(0, sep);
  const data = [...s.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (sep < 3 || data.some((d) => d < 0)) throw new Error('not a BOLT 11 invoice (bech32 characters)');
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('invoice checksum is wrong (a typo or a cut-off invoice)');
  const m = /^ln(bcrt|bc|tbs|tb)(?:(\d+)([munp]?))?$/.exec(hrp);
  if (!m) throw new Error(`unknown invoice prefix "${hrp}"`);
  let msat = null;
  if (m[2]) {
    if (m[3] === 'p') {
      const p = BigInt(m[2]);
      if (p % 10n) throw new Error('a pico-BTC amount must be a multiple of 10');
      msat = p / 10n;
    } else msat = BigInt(m[2]) * MSAT_PER[m[3]];
  }
  const words = data.slice(0, -6);
  const num = (ws) => ws.reduce((a, w) => a * 32 + w, 0);
  const timestamp = num(words.slice(0, 7));
  let expiry = 3600;
  for (let i = 7; i + 3 <= words.length - 104;) {
    const type = words[i], len = words[i + 1] * 32 + words[i + 2];
    if (type === 6) expiry = num(words.slice(i + 3, i + 3 + len)); // 'x'
    i += 3 + len;
  }
  return { network: NETWORKS[m[1]], msat, timestamp, expiry, expiresAt: (timestamp + expiry) * 1000 };
}

function macaroonBytes(value) {
  const v = String(value || '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
  return Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

const sats = (msat) => (msat === null ? null : Number(msat) / 1000);

// The L402 checks for a 402 response. Returns { challenges } or null without an L402/LSAT challenge.
async function checkL402({ res, url, method, body, safeFetch, now = Date.now() }, checks) {
  const header = headerValue(res.headers, 'www-authenticate');
  if (!header || !schemeStarts(header).length) return null;
  const parsed = parseL402(header);
  const broken = parsed.find((c) => c.error);
  if (broken) addCheck(checks, 'l402-challenge', 'fail', `L402 challenge can't be read: ${broken.error}.`, { hint: 'Send WWW-Authenticate: L402 macaroon="<base64>", invoice="<BOLT 11 invoice>".' });
  const ok = parsed.filter((c) => !c.error);
  const usable = ok.filter((c) => c.params.macaroon && c.params.invoice);
  if (!usable.length) {
    if (ok.length) addCheck(checks, 'l402-challenge', 'fail', `L402 challenge without ${ok[0].params.macaroon ? 'invoice' : 'macaroon'}: the client needs both a macaroon and a Lightning invoice.`, { hint: 'Send WWW-Authenticate: L402 macaroon="<base64>", invoice="<BOLT 11 invoice>".' });
    return { challenges: [] };
  }
  const schemes = [...new Set(ok.map((c) => c.scheme))];
  addCheck(checks, 'l402-challenge', 'pass', `L402 challenge (WWW-Authenticate: ${schemes.join(' and ')}) with a macaroon and a Lightning invoice.`);
  if (schemes.length === 1) addCheck(checks, 'l402-lsat', 'info', schemes[0] === 'L402' ? 'Only the L402 scheme is sent; older Lightning clients look for LSAT.' : 'Only the old LSAT scheme is sent; current clients look for L402.', { hint: 'Send the same challenge as LSAT first and L402 second (the spec says so for compatibility).' });

  const c = usable.find((x) => x.scheme === 'L402') || usable[0];
  const mac = macaroonBytes(c.params.macaroon);
  if (!mac || mac.length < 16) addCheck(checks, 'l402-macaroon', 'fail', "The macaroon isn't base64, or too short to be one.", { hint: 'Send the serialized macaroon, base64-encoded (RFC 4648).' });
  else addCheck(checks, 'l402-macaroon', 'pass', `Macaroon is base64 (${mac.length} bytes${mac[0] === 2 ? ', v2' : ''}).`);

  let inv = null;
  try { inv = decodeBolt11(c.params.invoice); } catch (err) {
    addCheck(checks, 'l402-invoice', 'fail', `The invoice can't be read: ${err.message}.`, { hint: 'invoice must be a BOLT 11 payment request (lnbc…) from your Lightning node.' });
  }
  if (inv) {
    if (inv.network !== 'bitcoin') addCheck(checks, 'l402-network', 'warn', `The invoice is for ${inv.network}, not bitcoin mainnet: real agents can't pay it.`, { hint: 'Fine for testing; issue mainnet invoices (lnbc…) in production.' });
    else addCheck(checks, 'l402-network', 'pass', 'Invoice on bitcoin mainnet.');
    if (inv.msat === null) addCheck(checks, 'l402-amount', 'warn', 'The invoice has no amount: the client has to pick one, so agents (and Doctor) cannot price this call.', { hint: 'Put the price in the invoice (e.g. lnbc100n… is 10 sats).' });
    else addCheck(checks, 'l402-amount', 'pass', `Price: ${sats(inv.msat)} sats.`);
    if (!(inv.expiresAt > now)) addCheck(checks, 'l402-expiry', 'fail', `The invoice expired at ${new Date(inv.expiresAt).toISOString()}: every payment is refused.`, { hint: 'Make a fresh invoice for every 402, and check the server clock.' });
    else addCheck(checks, 'l402-expiry', 'pass', `Invoice valid for ${Math.max(0, Math.round((inv.expiresAt - now) / 60000))} more min.`);
  }

  // A made-up credential must get 401 (the spec), never the resource.
  if (typeof safeFetch === 'function') {
    try {
      const r = await safeFetch(url, {
        method,
        headers: { authorization: `L402 ${c.params.macaroon}:${'0'.repeat(64)}`, 'user-agent': 'x402-doctor (L402 bad-credential test)', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
        body: method === 'GET' ? undefined : body ?? '{}',
      });
      if (r.status === 401) addCheck(checks, 'l402-bad-credential', 'pass', 'A wrong preimage gets 401, as the spec says.');
      else if (r.status === 402) addCheck(checks, 'l402-bad-credential', 'warn', 'A wrong preimage gets 402 again; the spec says 401 once a credential is presented.', { hint: 'Answer 401 when the macaroon or preimage does not verify.' });
      else if (r.status >= 200 && r.status < 300) addCheck(checks, 'l402-bad-credential', 'fail', `A made-up preimage got HTTP ${r.status}: the resource is served without payment.`, { hint: 'Check that sha256(preimage) is the payment hash the macaroon commits to before serving.' });
      else if (r.status >= 500) addCheck(checks, 'l402-bad-credential', 'fail', `A wrong preimage crashes the endpoint (HTTP ${r.status}).`, { hint: 'Catch credential errors and answer 401.' });
      else addCheck(checks, 'l402-bad-credential', 'warn', `A wrong preimage gets HTTP ${r.status}; the spec says 401.`);
    } catch {
      // unreachable now: say nothing
    }
  }
  return { challenges: usable.map((x) => { let d = null; try { d = decodeBolt11(x.params.invoice); } catch { d = null; } return { scheme: x.scheme, network: d?.network ?? null, sats: d ? sats(d.msat) : null, expires: d ? new Date(d.expiresAt).toISOString() : null }; }) };
}

module.exports = { checkL402, parseL402, hasL402, decodeBolt11 };
