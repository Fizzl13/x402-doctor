// The browser paywall (@x402/paywall) puts the request URL and descriptions into an inline <script> as they are,
// without escaping "</script>" (x402-foundation/x402#3852; the fix, #3855, is not in @x402/paywall 2.28.0). Nothing
// reaches it today: the paid routes check their input before the 402, and a browser sends "<" in a URL as %3C. This
// keeps it that way if that ever changes: before the paywall builds the page, characters that could end a script or
// a string are percent-encoded in URLs (the same URL), and "<" becomes "‹" in other text. "$" in a URL is encoded
// too, so the paywall's own String.replace can't read it as a pattern ($&, $'). What the wallet signs is unchanged:
// payment options carry no such characters.

const URL_UNSAFE = /[<>"'`$\s]/g;
const encode = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

function scriptSafe(value, key) {
  if (typeof value === 'string') return /url$/i.test(key || '') ? value.replace(URL_UNSAFE, encode) : value.replace(/</g, '‹');
  if (Array.isArray(value)) return value.map((v) => scriptSafe(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scriptSafe(v, k)]));
  return value;
}

// A paywall provider ({ generateHtml }) that hands the paywall only script-safe values.
function scriptSafePaywall(paywall) {
  return { generateHtml: (paymentRequired, config) => paywall.generateHtml(scriptSafe(paymentRequired), scriptSafe(config)) };
}

module.exports = { scriptSafe, scriptSafePaywall };
