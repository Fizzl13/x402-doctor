// Reads the usage log (see usage-log.js) back from the private GitHub repo
// for /admin/usage. Files are cached by blob sha, so a refresh only
// downloads the day files that changed.

'use strict';

const API = 'https://api.github.com';
const MAX_EVENTS = 20000;

function createUsageReader({ env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  const token = env.USAGE_LOG_TOKEN;
  const repo = env.USAGE_LOG_REPO || 'Fizzl13/usage-log';
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'usage-reader',
  };
  const blobs = new Map(); // sha -> parsed events

  async function getJson(url, accept) {
    const res = await fetchFn(url, { headers: accept ? { ...headers, accept } : headers });
    if (res.status === 404 || res.status === 409) return null; // missing or empty repo
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} for ${url.replace(API, '')}`);
    return accept ? res.text() : res.json();
  }

  function parseLines(text) {
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip a damaged line
      }
    }
    return events;
  }

  async function load({ days = 30 } = {}) {
    if (!token) return { configured: false, repo, events: [] };
    const from = new Date(now() - days * 86400000).toISOString().slice(0, 10);
    const tree = await getJson(`${API}/repos/${repo}/git/trees/HEAD?recursive=1`);
    const files = ((tree && tree.tree) || [])
      .filter((f) => f.type === 'blob' && /^events\/[^/]+\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.path))
      .filter((f) => f.path.slice(-16, -6) >= from);

    const events = [];
    const errors = [];
    await Promise.all(files.map(async (f) => {
      try {
        if (!blobs.has(f.sha)) {
          const text = await getJson(`${API}/repos/${repo}/git/blobs/${f.sha}`, 'application/vnd.github.raw+json');
          blobs.set(f.sha, parseLines(text || ''));
        }
        events.push(...blobs.get(f.sha));
      } catch (err) {
        errors.push(`${f.path}: ${err.message}`);
      }
    }));
    if (blobs.size > 2000) blobs.clear();

    const fromIso = new Date(now() - days * 86400000).toISOString();
    const inRange = events.filter((e) => e && typeof e.t === 'string' && e.t >= fromIso).sort((a, b) => (a.t < b.t ? 1 : -1));
    return { configured: true, repo, days, from: fromIso, truncated: inRange.length > MAX_EVENTS, events: inRange.slice(0, MAX_EVENTS), errors };
  }

  return { configured: Boolean(token), load };
}

module.exports = { createUsageReader };
