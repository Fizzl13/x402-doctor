// Extra views for the usage dashboard (/admin/usage):
//   - languageOf(agent): the programming language a caller is written in, from its user agent
//     ("node", "axios/1.x", "python-httpx/0.28", "Go-http-client/2.0", our own packages…). A made-up name
//     such as "CarbonMonitor/0.1" doesn't say, so it is "own name".
//   - createAgentKinds(): what kind of caller a made-up user agent is (monitor, directory or indexer,
//     an agent or app using the answer), judged once per name by TypeSafe's Jev and kept in memory.
//     Off without TYPESAFE_API_KEY; any failure leaves the name "unknown".
//   - createDownloads(): daily npm and PyPI downloads of our packages (JavaScript and Python), cached.
'use strict';

const LANGUAGES = [
  [/^(x402-safe-fetch|presign-guard-(wallet-mcp|wallet|agentkit|ai-sdk))\//i, 'JavaScript'],
  [/^fizzl-py\//i, 'Python'],
  [/^(node|undici|axios|node-fetch|got|ky|bun|deno|superagent|needle|okhttp-js)\b/i, 'JavaScript'],
  [/^(python|aiohttp|httpx|urllib|requests|scrapy|httplib2|pycurl)\b/i, 'Python'],
  [/^go-http-client|^go\b|^resty\b/i, 'Go'],
  [/^(guzzlehttp|php|symfony)\b/i, 'PHP'],
  [/^(okhttp|java|apache-httpclient|ktor|jersey)\b/i, 'Java/Kotlin'],
  [/^(ruby|faraday|httparty|typhoeus)\b/i, 'Ruby'],
  [/^(reqwest|hyper|ureq|curl-rust)\b/i, 'Rust'],
  [/^(dart|dio)\b/i, 'Dart'],
  [/^(\.net|dotnet|restsharp|system\.net)\b/i, 'C#/.NET'],
  [/^(curl|wget|httpie)\b/i, 'curl/shell'],
  [/^(browser|mozilla)\b/i, 'Browser'],
];

function languageOf(agent) {
  const a = String(agent || '').trim();
  if (!a || a === 'none') return 'Not sent';
  for (const [re, lang] of LANGUAGES) if (re.test(a)) return lang;
  return 'Own name';
}

// Generic HTTP clients and browsers say what they are; only made-up names go to Jev.
const KIND_QUESTIONS = {
  monitor: {
    type: 'noul',
    instructions: 'Is the HTTP user agent `agent` an uptime monitor, health check, liveness or payment probe, or a test harness that checks whether an API works, rather than something that uses the answers?',
    criteria: { true: 'A monitor, probe, health check or test harness', false: 'Something else' },
  },
  directory: {
    type: 'noul',
    instructions: 'Is the HTTP user agent `agent` a directory, index, census, crawler, search engine, ranking or discovery service that lists or catalogues APIs?',
    criteria: { true: 'A directory, indexer, census, crawler or discovery service', false: 'Something else' },
  },
  agent: {
    type: 'noul',
    instructions: 'Is the HTTP user agent `agent` an AI agent, trading bot, wallet or application that calls an API to use its answers for its own work?',
    criteria: { true: 'An AI agent, bot or app that uses the answers', false: 'Something else' },
  },
};
const KIND_LABELS = { monitor: 'Monitor or probe', directory: 'Directory or indexer', agent: 'Agent or app', library: 'HTTP library (no name)', browser: 'Browser', package: 'Our packages', unknown: 'Unknown' };

function createAgentKinds({ apiKey = process.env.TYPESAFE_API_KEY, fetch: fetchImpl = globalThis.fetch, model = process.env.JEV_MODEL || 'jev-latest', timeoutMs = 5000, perPass = 25, log = console } = {}) {
  const enabled = Boolean(apiKey) && process.env.JEV_CHECK !== 'off';
  const cache = new Map(); // agent name (without version) -> kind key
  let running = null;

  const nameOf = (agent) => String(agent || '').split('/')[0].trim().slice(0, 80);
  function byCode(agent) {
    const lang = languageOf(agent);
    if (/^(x402-safe-fetch|presign-guard-|fizzl-py)/i.test(String(agent || ''))) return 'package';
    if (lang === 'Browser') return 'browser';
    if (lang !== 'Own name') return 'library';
    if (/(^|[^a-z])(monitor|probe|health|uptime|liveness|prober)/i.test(agent)) return 'monitor';
    if (/(crawler|indexer|census|bot$|bot\/|spider|discovery)/i.test(agent)) return 'directory';
    return null;
  }

  async function judge(name) {
    try {
      const res = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state: { agent: name }, questions: KIND_QUESTIONS }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { log.warn?.(`[jev kinds] HTTP ${res.status}`); return null; }
      const a = (await res.json())?.answers || {};
      const scores = Object.keys(KIND_QUESTIONS).map((k) => [k, a[k]?.noul]).filter(([, v]) => typeof v === 'number').sort((x, y) => y[1] - x[1]);
      return scores.length && scores[0][1] >= 0.5 ? scores[0][0] : 'unknown';
    } catch (err) {
      log.warn?.(`[jev kinds] ${err.name}: ${err.message}`);
      return null;
    }
  }

  // Ask Jev about names not seen before, most frequent first, a few per pass, in the background.
  function learn(counts) {
    if (!enabled || running) return;
    const todo = [...counts].filter(([n]) => !cache.has(n)).sort((x, y) => y[1] - x[1]).slice(0, perPass).map(([n]) => n);
    if (!todo.length) return;
    running = (async () => {
      for (const n of todo) { const k = await judge(n); if (k) cache.set(n, k); }
    })().finally(() => { running = null; });
  }

  // { agent string -> label } for every agent in events; unknown names are learned for the next load.
  function kindsFor(events) {
    const out = {};
    const ask = new Map();
    for (const e of events) {
      const agent = e.agent;
      if (!agent || out[agent]) continue;
      const code = byCode(agent);
      if (code) { out[agent] = KIND_LABELS[code]; continue; }
      const n = nameOf(agent);
      if (cache.has(n)) out[agent] = KIND_LABELS[cache.get(n)];
      else { out[agent] = KIND_LABELS.unknown; ask.set(n, 0); }
    }
    for (const e of events) { const n = nameOf(e.agent); if (ask.has(n)) ask.set(n, ask.get(n) + 1); }
    learn(ask);
    return out;
  }

  return { enabled, kindsFor, byCode, cache };
}

// Our packages on npm (JavaScript) and PyPI (Python). Daily downloads over the last 30 days.
const PACKAGES = [
  { name: 'x402-safe-fetch', registry: 'npm', language: 'JavaScript' },
  { name: 'presign-guard-wallet', registry: 'npm', language: 'JavaScript' },
  { name: 'presign-guard-wallet-mcp', registry: 'npm', language: 'JavaScript' },
  { name: 'presign-guard-agentkit', registry: 'npm', language: 'JavaScript' },
  { name: 'presign-guard-ai-sdk', registry: 'npm', language: 'JavaScript' },
  { name: 'fizzl', registry: 'pypi', language: 'Python' },
];

function createDownloads({ fetch: fetchImpl = globalThis.fetch, ttlMs = 6 * 3600 * 1000, now = () => Date.now(), timeoutMs = 10000 } = {}) {
  let cached = null;
  let pending = null;

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'fizzl-usage-dashboard/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return null; // a package's first days
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function one(p) {
    try {
      if (p.registry === 'npm') {
        const j = await getJson(`https://api.npmjs.org/downloads/range/last-month/${p.name}`);
        return { ...p, days: Object.fromEntries((j?.downloads || []).map((d) => [d.day, d.downloads])) };
      }
      const j = await getJson(`https://pypistats.org/api/packages/${p.name}/overall?mirrors=false`);
      return { ...p, days: Object.fromEntries((j?.data || []).filter((d) => d.category === 'without_mirrors').map((d) => [d.date, d.downloads])) };
    } catch (err) {
      return { ...p, days: {}, error: err.message };
    }
  }

  async function load() {
    if (cached && now() - cached.at < ttlMs && !cached.packages.some((p) => p.error)) return cached.data;
    if (!pending) {
      pending = Promise.all(PACKAGES.map(one)).then((packages) => {
        // Keep the last good numbers for a package whose registry failed this time.
        const merged = packages.map((p) => (p.error && cached ? { ...(cached.packages.find((c) => c.name === p.name) || p), error: p.error } : p));
        cached = { at: now(), packages: merged, data: { fetched_at: new Date(now()).toISOString(), packages: merged } };
        return cached.data;
      }).finally(() => { pending = null; });
    }
    return pending;
  }

  return { load };
}

module.exports = { languageOf, createAgentKinds, createDownloads, KIND_LABELS, PACKAGES };
