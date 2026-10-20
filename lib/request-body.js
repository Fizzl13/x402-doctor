// request-body.js — an example request body for a POST endpoint that checks its input before the 402.
//
// Many sellers validate the JSON body first and only ask for payment for a valid request ("csvText is
// required" → 400, a valid body → 402). That is the right order, but a probe with an empty body ({}) then
// never sees the 402. The caller can give an example body; otherwise this looks for one in the seller's own
// /openapi.json: the operation's requestBody example, its first named example, the schema's example, or a
// minimal object built from the schema's required properties. Nothing here is run; the text is only sent
// back to the same endpoint once, as the body of one unpaid POST.
'use strict';

const MAX_BODY_BYTES = 16 * 1024;

// Resolve a local $ref ("#/components/schemas/X"); anything else is left as is.
function deref(doc, node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const target = node.$ref.slice(2).split('/').reduce((o, k) => (o && typeof o === 'object' ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
    return deref(doc, target, depth + 1);
  }
  return node;
}

// A minimal value that satisfies a schema's types: example, default, const or the first enum value when the
// schema gives one, else a placeholder of the right type. Objects get their required properties only.
function sampleOf(doc, schema, depth = 0) {
  const s = deref(doc, schema);
  if (!s || typeof s !== 'object' || depth > 6) return undefined;
  for (const key of ['example', 'default', 'const']) if (s[key] !== undefined) return s[key];
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const variants = s.oneOf || s.anyOf;
  if (Array.isArray(variants) && variants.length) return sampleOf(doc, variants[0], depth + 1);
  if (Array.isArray(s.allOf) && s.allOf.length) {
    const parts = s.allOf.map((x) => sampleOf(doc, x, depth + 1)).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (parts.length) return Object.assign({}, ...parts);
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (type === 'object' || (!type && s.properties)) {
    const out = {};
    for (const name of Array.isArray(s.required) ? s.required : []) {
      const value = sampleOf(doc, s.properties?.[name], depth + 1);
      out[name] = value === undefined ? 'example' : value;
    }
    return out;
  }
  if (type === 'array') {
    const item = sampleOf(doc, s.items, depth + 1);
    const min = Number.isInteger(s.minItems) ? s.minItems : 0;
    return item === undefined ? [] : Array.from({ length: Math.max(min, 1) }, () => item);
  }
  if (type === 'string') {
    if (s.format === 'email') return 'agent@example.com';
    if (s.format === 'uri' || s.format === 'url') return 'https://example.com';
    if (s.format === 'date') return '2026-01-01';
    if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
    const min = Number.isInteger(s.minLength) ? s.minLength : 0;
    return 'example'.padEnd(min, 'x');
  }
  if (type === 'integer' || type === 'number') return typeof s.minimum === 'number' ? s.minimum : 1;
  if (type === 'boolean') return true;
  return undefined;
}

// The operation in an OpenAPI document that serves this URL and method: the exact path first, then a
// templated one (/v1/items/{id}), with any server base path taken off.
function operationFor(doc, targetUrl, method) {
  const paths = doc && typeof doc.paths === 'object' ? doc.paths : null;
  if (!paths) return null;
  const pathname = new URL(targetUrl).pathname.replace(/\/+$/, '') || '/';
  const bases = ['', ...(Array.isArray(doc.servers) ? doc.servers : []).map((s) => {
    try { return new URL(s.url, targetUrl).pathname.replace(/\/+$/, ''); } catch { return ''; }
  })];
  const m = method.toLowerCase();
  for (const base of bases) {
    if (base && !pathname.startsWith(base)) continue;
    const rest = pathname.slice(base.length) || '/';
    if (paths[rest]?.[m]) return paths[rest][m];
    for (const [p, item] of Object.entries(paths)) {
      if (!p.includes('{') || !item?.[m]) continue;
      const re = new RegExp(`^${p.replace(/\/+$/, '').replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`);
      if (re.test(rest)) return item[m];
    }
  }
  return null;
}

// { body, source } for the operation, or null. source says where the example came from, for the report.
function exampleFromOpenApi(doc, targetUrl, method = 'POST') {
  const op = operationFor(doc, targetUrl, method);
  const content = deref(doc, op?.requestBody)?.content;
  if (!content || typeof content !== 'object') return null;
  const type = Object.keys(content).find((t) => /json/i.test(t));
  if (!type) return null;
  const media = content[type] || {};
  let value;
  let source;
  if (media.example !== undefined) [value, source] = [media.example, 'requestBody example'];
  else if (media.examples && typeof media.examples === 'object') {
    const first = deref(doc, Object.values(media.examples)[0]);
    if (first && first.value !== undefined) [value, source] = [first.value, 'requestBody examples'];
  }
  if (value === undefined && media.schema) {
    const schema = deref(doc, media.schema);
    if (schema?.example !== undefined) [value, source] = [schema.example, 'schema example'];
    else {
      const built = sampleOf(doc, schema);
      if (built !== undefined && !(built && typeof built === 'object' && !Array.isArray(built) && !Object.keys(built).length)) [value, source] = [built, 'schema'];
    }
  }
  if (value === undefined) return null;
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  if (!body || Buffer.byteLength(body) > MAX_BODY_BYTES) return null;
  return { body, source: `${source} in /openapi.json` };
}

// Parsed /openapi.json per origin for 10 minutes (null when there is none), so a seller with many such routes
// (the daily Trust Index scan) is asked once.
const docs = new Map();
const DOC_TTL_MS = 10 * 60 * 1000;
const MAX_DOCS = 200;

async function openApiOf(origin, safeFetch, now = Date.now()) {
  const hit = docs.get(origin);
  if (hit && now - hit.at < DOC_TTL_MS) return hit.doc;
  let doc = null;
  try {
    const res = await safeFetch(`${origin}/openapi.json`);
    if (res.status === 200 && !res.truncated) doc = JSON.parse(res.text);
  } catch {
    doc = null;
  }
  if (docs.size >= MAX_DOCS) docs.delete(docs.keys().next().value);
  docs.set(origin, { at: now, doc });
  return doc;
}

// The seller's /openapi.json (one request per origin) → { body, source } for this POST, or null.
async function findExampleBody(targetUrl, safeFetch, method = 'POST') {
  try {
    const doc = await openApiOf(new URL(targetUrl).origin, safeFetch);
    return doc ? exampleFromOpenApi(doc, targetUrl, method) : null;
  } catch {
    return null;
  }
}

// A caller's example body, as sent to the endpoint: a JSON string, or an object/array that is serialised.
// Returns { body } or { error }.
function normaliseBody(input) {
  if (input === undefined || input === null || input === '') return { body: undefined };
  const body = typeof input === 'string' ? input : JSON.stringify(input);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { error: `body is too large (max ${MAX_BODY_BYTES / 1024} KB)` };
  try {
    JSON.parse(body);
  } catch {
    return { error: 'body must be JSON' };
  }
  return { body };
}

module.exports = { exampleFromOpenApi, findExampleBody, normaliseBody, sampleOf, MAX_BODY_BYTES, _docs: docs };
