// Usage log: one JSON line per call, appended to a private GitHub repo
// (events/<service>/<YYYY-MM-DD>.jsonl), read back by /admin/usage.
//
// The same file is copied into each Fizzl service. It needs two settings:
//   USAGE_LOG_TOKEN  fine-grained GitHub token, Contents read/write on the log repo only
//   USAGE_LOG_REPO   owner/name of the log repo (default Fizzl13/usage-log)
// Without a token it does nothing. Writing never delays or breaks a request:
// events are queued and flushed in the background, one commit per flush.

'use strict';

const DEFAULT_REPO = 'Fizzl13/usage-log';
const API = 'https://api.github.com';
const MAX_TEXT = 300;

// Keeps inputs readable and bounded: long strings are cut, objects are
// serialised and cut, nothing nested deeper than needed.
function clip(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return '[unserialisable]';
  }
  return text.length > max ? `${text.slice(0, max)}…` : value;
}

function clipAll(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = clip(v);
  return out;
}

const NETWORK_NAMES = {
  'eip155:8453': 'base',
  'eip155:84532': 'base-sepolia',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet',
};

function decodeBase64Json(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// What was paid, from the request's payment header (amount, network) and the
// response's settlement header (transaction, payer). Null when not paid.
function paymentOf(req, res) {
  const settlement = decodeBase64Json(res.getHeader('PAYMENT-RESPONSE') || res.getHeader('X-PAYMENT-RESPONSE'));
  if (!settlement || settlement.success === false) return null;
  const payload = decodeBase64Json(req.headers['payment-signature'] || req.headers['x-payment']);
  const accepted = payload && (payload.accepted || payload.requirements);
  const network = settlement.network || (accepted && accepted.network) || null;
  const atomic = accepted && (accepted.amount || accepted.maxAmountRequired);
  return {
    usd: atomic !== undefined && atomic !== null && /^\d+$/.test(String(atomic)) ? Number(atomic) / 1e6 : null,
    network: NETWORK_NAMES[network] || network,
    payer: settlement.payer || null,
    tx: settlement.transaction || null,
  };
}

function createUsageLog({ service, env = process.env, fetchFn = globalThis.fetch, now = () => new Date(), log = console } = {}) {
  const token = env.USAGE_LOG_TOKEN;
  const repo = env.USAGE_LOG_REPO || DEFAULT_REPO;
  const queue = [];
  let flushing = null;
  let warned = false;

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': `usage-log/${service}`,
  };

  // Appends lines to one file: read (for the sha), write, retry on a race.
  async function append(path, lines) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const url = `${API}/repos/${repo}/contents/${path}`;
      const current = await fetchFn(url, { headers });
      let sha;
      let text = '';
      if (current.status === 200) {
        const file = await current.json();
        sha = file.sha;
        text = Buffer.from(file.content || '', 'base64').toString('utf8');
      } else if (current.status !== 404) {
        throw new Error(`read ${path}: HTTP ${current.status}`);
      }
      const body = {
        message: `${service}: ${lines.length} call${lines.length === 1 ? '' : 's'}`,
        content: Buffer.from(text + lines.join('\n') + '\n').toString('base64'),
        ...(sha ? { sha } : {}),
      };
      const put = await fetchFn(url, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (put.status === 200 || put.status === 201) return;
      if (put.status !== 409 && put.status !== 422) throw new Error(`write ${path}: HTTP ${put.status}`);
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
    throw new Error(`write ${path}: gave up after retries`);
  }

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      while (queue.length) {
        const batch = queue.splice(0, queue.length);
        const byFile = new Map();
        for (const event of batch) {
          const path = `events/${service}/${event.t.slice(0, 10)}.jsonl`;
          if (!byFile.has(path)) byFile.set(path, []);
          byFile.get(path).push(JSON.stringify(event));
        }
        for (const [path, lines] of byFile) {
          try {
            await append(path, lines);
          } catch (err) {
            log.error(`[usage-log] ${err.message}; ${lines.length} event(s) dropped`);
          }
        }
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  function record(event) {
    if (!token) {
      if (!warned) log.warn('[usage-log] USAGE_LOG_TOKEN not set: calls are not logged');
      warned = true;
      return;
    }
    queue.push({ t: now().toISOString(), service, ...event, input: clipAll(event.input), result: clipAll(event.result) });
    flush();
  }

  // Express middleware. describe(req, res, body) returns { route, input, result, via }
  // for calls worth logging, or null to skip (static files, health, probes).
  // 402 challenges and other failed payments are not calls and are skipped.
  function middleware(describe) {
    return (req, res, next) => {
      if (req.method === 'OPTIONS' || req.method === 'HEAD') return next();
      const started = Date.now();
      let body;
      const json = res.json.bind(res);
      res.json = (b) => {
        body = b;
        return json(b);
      };
      res.on('finish', () => {
        if (res.statusCode === 402) return;
        let described;
        try {
          described = describe(req, res, body);
        } catch {
          described = null;
        }
        if (!described) return;
        const payment = paymentOf(req, res);
        record({
          route: described.route,
          via: described.via || 'http',
          status: res.statusCode,
          ms: Date.now() - started,
          paid: Boolean(payment),
          ...(payment || {}),
          input: described.input,
          result: described.result,
        });
      });
      next();
    };
  }

  return { enabled: Boolean(token), record, middleware, flush, repo };
}

// The JSON-RPC tools/call in an MCP request body, as { tool, args }, or null.
function mcpToolCall(body) {
  const calls = Array.isArray(body) ? body : [body];
  const call = calls.find((c) => c && c.method === 'tools/call');
  return call ? { tool: call.params && call.params.name, args: call.params && call.params.arguments } : null;
}

module.exports = { createUsageLog, paymentOf, mcpToolCall, clip };
