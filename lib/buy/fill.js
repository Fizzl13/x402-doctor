// The request for one seller, filled in from the need (buy-server.js). Every paid API wants its own input; Claude reads
// the listing (method, URL, description, the example input its Bazaar listing declares) and the need, and answers the
// input with the example's keys and values taken from the need, or that this API can't answer it. Code builds the
// request: path parameters (/weather/:city, /price/{symbol}) go into the path, the rest into the query (GET) or the
// JSON body (POST).
'use strict';

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const SYSTEM = 'You fill in a request to a paid web API for an AI agent. You get the agent\'s need and the API listing: method, URL, description and an example input. Answer only a JSON object {"fits": true or false, "input": {...}, "reason": "..."}. fits is false when this API cannot answer the need. input uses the keys of the example input (and the URL\'s :param or {param} path parameters), with values taken from the need; keep an example value only where the need says nothing and the value doesn\'t change what is asked (such as a number of days). Never invent identifiers, addresses or names the need doesn\'t give. reason is one short sentence.';

const PATH_PARAM = /:([A-Za-z_][\w-]*)|\{([^/{}]+)\}/g;

// { method, url, body } for a listing and an input; path parameters without a value leave it null.
function requestOf(candidate, input) {
  const values = input && typeof input === 'object' ? { ...input } : {};
  let missing = false;
  const u = new URL(candidate.url.replace(PATH_PARAM, (m, a, b) => {
    const k = a || b;
    if (values[k] === undefined || values[k] === null || values[k] === '') { missing = true; return m; }
    const v = String(values[k]);
    delete values[k];
    return encodeURIComponent(v);
  }));
  if (missing) return null;
  const method = String(candidate.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  if (method === 'GET') {
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    return { method, url: u.href, body: undefined };
  }
  return { method, url: u.href, body: JSON.stringify(values) };
}

function createFiller({ apiKey = process.env.ANTHROPIC_API_KEY, fetch: fetchImpl = globalThis.fetch, model = CLAUDE_MODEL, timeoutMs = 15000 } = {}) {
  const enabled = Boolean(apiKey);
  // { fits, request, input, reason } or { fits: false, reason }.
  async function fill(need, candidate) {
    if (!enabled) return { fits: false, reason: 'the request filler (ANTHROPIC_API_KEY) is not set up' };
    const listing = { method: candidate.method || 'GET', url: candidate.url, description: candidate.description, example_input: candidate.example ?? {} };
    let text = '';
    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          // Haiku 5.5 with thinking off and effort low (scripts/claude-model-compare.mjs); another model gets the plain request.
          ...(/^claude-haiku-5/.test(model) && { thinking: { type: 'disabled' }, output_config: { effort: 'low' } }),
          max_tokens: 400,
          system: SYSTEM,
          messages: [{ role: 'user', content: JSON.stringify({ need: String(need).slice(0, 500), api: listing }) }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { fits: false, reason: `the request filler answered HTTP ${res.status}` };
      text = (await res.json())?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
    } catch (err) {
      return { fits: false, reason: `the request filler failed: ${err.message}` };
    }
    let answer;
    try { answer = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return { fits: false, reason: 'the request filler gave no JSON' }; }
    if (!answer?.fits) return { fits: false, reason: String(answer?.reason || 'this API cannot answer the need').slice(0, 200) };
    const request = requestOf(candidate, answer.input);
    if (!request) return { fits: false, reason: 'a path parameter of this API has no value in the need' };
    return { fits: true, request, input: answer.input ?? {}, reason: String(answer.reason || '').slice(0, 200) };
  }
  return { enabled, fill };
}

module.exports = { createFiller, requestOf, SYSTEM };
