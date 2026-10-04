// MPP (Machine Payments Protocol, Stripe + Tempo): the other HTTP 402 standard.
// A 402 carries `WWW-Authenticate: Payment id="…", realm="…", method="tempo",
// intent="charge", request="<base64url JSON>", expires="…"` (one challenge per
// payment method); the client retries with `Authorization: Payment <credential>`
// and gets a `Payment-Receipt` back. Spec: draft-httpauth-payment (IETF),
// https://paymentauth.org. These checks read the challenge only; nothing is paid.

const MAX_REQUEST_PARAM = 16 * 1024;
const isAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isIntString = (v) => typeof v === 'string' && /^\d+$/.test(v) && v.length <= 78;

function addCheck(checks, id, status, message, extra = {}) {
  checks.push({ id, status, message, group: 'mpp', ...extra });
}

// Where each `Payment` challenge starts in a (possibly merged) WWW-Authenticate value.
function paymentStarts(header) {
  const starts = [];
  const re = /(?:^|,)\s*(Payment)\s+(?=[A-Za-z0-9_-]+\s*=)/gi;
  let m;
  while ((m = re.exec(header))) starts.push(m.index + m[0].indexOf(m[1]));
  return starts;
}

// RFC 9110 auth-params: token=token or token="quoted \"string\"". Stops at the next scheme.
function parseAuthParams(input) {
  const out = Object.create(null);
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /[\s,]/.test(input[i])) i++;
    if (i >= input.length) break;
    const start = i;
    while (i < input.length && /[A-Za-z0-9_-]/.test(input[i])) i++;
    const key = input.slice(start, i).toLowerCase();
    if (!key) throw new Error('malformed auth-param');
    while (i < input.length && /\s/.test(input[i])) i++;
    if (input[i] !== '=') break; // another auth scheme begins here
    i++;
    while (i < input.length && /\s/.test(input[i])) i++;
    let value = '';
    if (input[i] === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) i++;
        value += input[i++];
      }
      if (input[i] !== '"') throw new Error('unterminated quoted string');
      i++;
    } else {
      const vs = i;
      while (i < input.length && !/[\s,]/.test(input[i])) i++;
      value = input.slice(vs, i);
    }
    if (key in out) throw new Error(`duplicate parameter "${key}"`);
    out[key] = value;
  }
  return out;
}

function decodeRequest(value) {
  if (value.length > MAX_REQUEST_PARAM) throw new Error('request parameter too large');
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('request is not base64url');
  const json = Buffer.from(value.replace(/=+$/, ''), 'base64url').toString('utf8');
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request is not a JSON object');
  return parsed;
}

// All Payment challenges in a WWW-Authenticate value: [{ params, request, error }].
function parseChallenges(header) {
  const starts = paymentStarts(header);
  return starts.map((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : header.length;
    const chunk = header.slice(start + 'Payment'.length, end).replace(/,\s*$/, '');
    try {
      const params = parseAuthParams(chunk);
      if (!params.request) return { params, error: 'no request="<base64url JSON>" parameter' };
      return { params, request: decodeRequest(params.request) };
    } catch (err) {
      return { params: {}, error: err.message };
    }
  });
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name);
  return hit ? (Array.isArray(hit[1]) ? hit[1].join(', ') : hit[1]) : null;
}

const hasPayment = (headers) => {
  const h = headerValue(headers, 'www-authenticate');
  return !!h && paymentStarts(h).length > 0;
};

function checkMethodFields(ch, tag, checks) {
  const r = ch.request, method = ch.params.method;
  const amount = () => {
    if (isIntString(r.amount)) return true;
    addCheck(checks, 'mpp-amount', 'fail', `${tag}request.amount ${r.amount === undefined ? 'is missing' : `is ${JSON.stringify(r.amount).slice(0, 40)}`}: it must be a string of digits in the smallest unit.`, { hint: 'For USDC (6 decimals) "10000" is $0.01; for Stripe in USD "100" is $1.00.' });
    return false;
  };
  if (method === 'tempo' || method === 'evm') {
    const splits = Array.isArray(r.methodDetails?.splits) && r.methodDetails.splits.length > 0;
    const okRecipient = isAddress(r.recipient) || (r.recipient === undefined && splits);
    if (!okRecipient) addCheck(checks, 'mpp-recipient', 'fail', `${tag}request.recipient ${r.recipient === undefined ? 'is missing' : 'is not a 0x address'}.`, { hint: 'Set request.recipient to your payout address (or methodDetails.splits for several).' });
    const okCurrency = isAddress(r.currency);
    if (!okCurrency) addCheck(checks, 'mpp-currency', 'fail', `${tag}request.currency must be the token contract address (0x…), got ${JSON.stringify(r.currency ?? null).slice(0, 50)}.`);
    const okAmount = amount();
    const chainId = r.methodDetails?.chainId;
    const okChain = method !== 'evm' || (Number.isSafeInteger(chainId) && chainId > 0);
    if (!okChain) addCheck(checks, 'mpp-chain', 'fail', `${tag}methodDetails.chainId is missing; an EVM payment has to say which chain.`, { hint: 'For Base mainnet: "methodDetails": {"chainId": 8453}.' });
    if (okRecipient && okCurrency && okAmount && okChain) addCheck(checks, 'mpp-fields', 'pass', `${tag}${Number(r.amount) / 1e6 >= 0.000001 && /^0x833589fcd6edb6e08f4c7c32d4f71b54bda02913$/i.test(r.currency) ? `$${(Number(r.amount) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC on Base` : `amount ${r.amount}`}${method === 'evm' ? ` (chain ${chainId})` : ' on Tempo'} to ${splits && !r.recipient ? 'split recipients' : r.recipient}.`);
    return;
  }
  if (method === 'stripe') {
    const okAmount = amount();
    const okCur = typeof r.currency === 'string' && /^[a-z]{3}$/i.test(r.currency);
    if (!okCur) addCheck(checks, 'mpp-currency', 'fail', `${tag}request.currency must be a three-letter currency code (e.g. "usd").`);
    const md = r.methodDetails || {};
    if (!md.networkId) addCheck(checks, 'mpp-stripe', 'fail', `${tag}methodDetails.networkId is missing (your Stripe profile id).`);
    if (!Array.isArray(md.paymentMethodTypes) || !md.paymentMethodTypes.length) addCheck(checks, 'mpp-stripe', 'fail', `${tag}methodDetails.paymentMethodTypes is missing or empty (e.g. ["card"]).`);
    if (okAmount && okCur && md.networkId && Array.isArray(md.paymentMethodTypes) && md.paymentMethodTypes.length) {
      addCheck(checks, 'mpp-fields', 'pass', `${tag}${(Number(r.amount) / 100).toFixed(2)} ${r.currency.toUpperCase()} via Stripe (${md.paymentMethodTypes.join(', ')}).`);
    }
    return;
  }
  addCheck(checks, 'mpp-fields', 'info', `${tag}payment method "${method}": not one Doctor knows the fields of (tempo, evm, stripe), so only the common parts were checked.`);
}

// The MPP checks for a 402 response. Returns { challenges } (parsed ones) or null when the 402 has no Payment challenge.
async function checkMpp({ res, url, method, body, safeFetch, now = Date.now() }, checks) {
  const header = headerValue(res.headers, 'www-authenticate');
  if (!header || !paymentStarts(header).length) return null;
  const parsed = parseChallenges(header);
  const broken = parsed.filter((c) => c.error);
  if (broken.length) {
    addCheck(checks, 'mpp-challenge', 'fail', `MPP challenge can't be read: ${broken[0].error}.`, {
      hint: 'Send WWW-Authenticate: Payment id="…", realm="your-host", method="tempo", intent="charge", request="<base64url of the JSON payment request>", expires="<ISO 8601>".',
    });
    if (broken.length === parsed.length) return { challenges: [] };
  }
  const ok = parsed.filter((c) => !c.error);
  const list = ok.map((c) => `${c.params.method || '?'}/${c.params.intent || '?'}`).join(', ');
  addCheck(checks, 'mpp-challenge', 'pass', `MPP challenge (WWW-Authenticate: Payment) with ${ok.length === 1 ? 'one payment option' : `${ok.length} payment options`}: ${list}.`);

  const host = new URL(url).hostname.toLowerCase();
  const missing = (key) => ok.filter((c) => !c.params[key]).length;
  if (missing('id')) addCheck(checks, 'mpp-id', 'fail', 'An MPP challenge has no id; clients send it back with the credential so the server can match the payment.', { hint: 'Give every challenge a unique id (mppx makes it an HMAC over the challenge).' });
  if (missing('method') || missing('intent')) addCheck(checks, 'mpp-method', 'fail', 'An MPP challenge has no method or intent (e.g. method="tempo", intent="charge").');
  const upper = ok.find((c) => c.params.method && !/^[a-z][a-z0-9:_-]*$/.test(c.params.method));
  if (upper) addCheck(checks, 'mpp-method', 'fail', `method="${upper.params.method}" must be lowercase.`);
  const noRealm = missing('realm');
  if (noRealm) addCheck(checks, 'mpp-realm', 'fail', 'An MPP challenge has no realm.', { hint: `Set realm="${host}".` });
  const badRealm = ok.map((c) => (c.params.realm || '').toLowerCase().replace(/\.$/, '')).find((r) => r && r !== host && !host.endsWith(`.${r}`));
  if (badRealm) addCheck(checks, 'mpp-realm', 'warn', `realm="${badRealm}" isn't this host (${host}). Clients may refuse a challenge for another domain.`, { hint: `Set realm="${host}" (or its base domain).` });
  else if (!noRealm) addCheck(checks, 'mpp-realm', 'pass', `realm matches ${host}.`);

  const noExp = ok.filter((c) => !c.params.expires);
  const expired = ok.find((c) => c.params.expires && !(Date.parse(c.params.expires) > now));
  if (expired) addCheck(checks, 'mpp-expires', 'fail', `MPP challenge expires="${expired.params.expires}" is in the past (or not an ISO 8601 date), so every payment against it is refused.`, { hint: 'Set expires a few minutes in the future when you make the challenge, and check the server clock.' });
  else if (noExp.length) addCheck(checks, 'mpp-expires', 'warn', 'An MPP challenge has no expires; without it an old challenge can be paid again later (replay).', { hint: 'Add expires="<ISO 8601, a few minutes ahead>".' });
  else addCheck(checks, 'mpp-expires', 'pass', `MPP challenge expires in ${Math.max(0, Math.round((Math.min(...ok.map((c) => Date.parse(c.params.expires))) - now) / 60000))} min.`);

  for (const c of ok) checkMethodFields(c, ok.length > 1 ? `[${c.params.method}] ` : '', checks);

  // A garbage credential must get a fresh 402 challenge, not a 500 (clients then pay again cleanly).
  if (typeof safeFetch === 'function') {
    try {
      const r = await safeFetch(url, {
        method,
        headers: { authorization: 'Payment dGhpcyBpcyBub3QgYSBjcmVkZW50aWFs', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
        body: method === 'GET' ? undefined : body ?? '{}',
      });
      if (r.status === 402 && hasPayment(r.headers)) addCheck(checks, 'mpp-bad-credential', 'pass', 'A malformed Payment credential gets 402 with a fresh challenge.');
      else if (r.status === 402) addCheck(checks, 'mpp-bad-credential', 'warn', 'A malformed Payment credential gets 402, but without a fresh WWW-Authenticate: Payment challenge, so the client cannot retry.', { hint: 'When you reject a credential, answer 402 with a new challenge.' });
      else if (r.status >= 500) addCheck(checks, 'mpp-bad-credential', 'fail', `A malformed Payment credential crashes the endpoint (HTTP ${r.status}).`, { hint: 'Catch credential parsing errors and answer 402 with a fresh challenge.' });
      else if (r.status >= 200 && r.status < 300) addCheck(checks, 'mpp-bad-credential', 'fail', `A made-up Payment credential got HTTP ${r.status}: the resource is served without a valid payment.`, { hint: 'Verify the credential (and the payment) before serving the resource.' });
      else addCheck(checks, 'mpp-bad-credential', 'warn', `A malformed Payment credential gets HTTP ${r.status}; clients expect 402 with a fresh challenge.`);
    } catch {
      // unreachable now: the earlier probe worked, so say nothing
    }
  }
  return { challenges: ok.map((c) => ({ ...c.params, request: c.request })) };
}

module.exports = { checkMpp, parseChallenges, hasPayment };
