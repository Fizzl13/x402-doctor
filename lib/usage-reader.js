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

  // A day file's events, downloaded once per version: /api/stats runs load() and summarizeAll() together and
  // both want today's files, so a download already under way is shared instead of started again.
  const downloading = new Map(); // sha -> Promise<events>
  function blobEvents(sha) {
    if (blobs.has(sha)) return Promise.resolve(blobs.get(sha));
    if (!downloading.has(sha)) {
      downloading.set(sha, getJson(`${API}/repos/${repo}/git/blobs/${sha}`, 'application/vnd.github.raw+json')
        .then((text) => parseLines(text || ''))
        .finally(() => downloading.delete(sha)));
    }
    return downloading.get(sha);
  }

  // service: only that service's day files (events/<service>/), e.g. the small trust-submit log.
  async function load({ days = 30, max = MAX_EVENTS, service } = {}) {
    if (!token) return { configured: false, repo, events: [] };
    const fromIso = new Date(now() - days * 86400000).toISOString();
    const from = fromIso.slice(0, 10);
    const tree = await getJson(`${API}/repos/${repo}/git/trees/HEAD?recursive=1`);
    const files = ((tree && tree.tree) || [])
      .filter((f) => f.type === 'blob' && /^events\/[^/]+\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.path))
      .filter((f) => f.path.slice(-16, -6) >= from)
      .filter((f) => !service || f.path.startsWith(`events/${service}/`));

    // Newest day first, stopping once there are max events: the answer is the newest max events, and every
    // event in an older day file is older than those (a file holds the events of its own UTC day). The admin
    // page asks 30 days but shows 20,000 events, about one day of traffic now; parsing all 30 days at once
    // could take the 512 MB instance down (13 Oct 2026).
    const dates = [...new Set(files.map((f) => f.path.slice(-16, -6)))].sort().reverse();
    const events = [];
    const errors = [];
    const used = new Set();
    let stoppedEarly = false;
    for (const [i, date] of dates.entries()) {
      if (events.length >= max) { stoppedEarly = i < dates.length; break; }
      await Promise.all(files.filter((f) => f.path.slice(-16, -6) === date).map(async (f) => {
        used.add(f.sha);
        try {
          if (!blobs.has(f.sha)) blobs.set(f.sha, await blobEvents(f.sha));
          for (const e of blobs.get(f.sha)) if (e && typeof e.t === 'string' && e.t >= fromIso) events.push(e); // not push(...): a big day file would overflow the stack
        } catch (err) {
          errors.push(`${f.path}: ${err.message}`);
        }
      }));
    }
    // Keep only the file versions this load used. Today's files get a new sha every few minutes, and
    // keeping the old versions leaked ~7 MB per /api/stats refresh until the 512 MB instance crashed
    // (13 Oct 2026). Older days keep their sha, so they stay cached.
    for (const sha of blobs.keys()) if (!used.has(sha)) blobs.delete(sha);

    events.sort((a, b) => (a.t < b.t ? 1 : -1));
    return { configured: true, repo, days, from: fromIso, truncated: stoppedEarly || events.length > max, events: events.slice(0, max), errors };
  }

  // A small summary per day file (e.g. counts) for the whole log, without
  // keeping its events: summarize(events, { service, date }) runs once per
  // file version.
  const summaries = new Map(); // sha -> summary
  async function summarizeAll(summarize) {
    if (!token) return { configured: false, files: [] };
    const tree = await getJson(`${API}/repos/${repo}/git/trees/HEAD?recursive=1`);
    const files = ((tree && tree.tree) || []).filter((f) => f.type === 'blob' && /^events\/[^/]+\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.path));
    const out = [];
    // A few files at a time: at startup every file is new, and reading them all at once raises the peak.
    const summarizeOne = async (f) => {
      const [, service, date] = /^events\/([^/]+)\/(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f.path);
      try {
        if (!summaries.has(f.sha)) {
          const events = await blobEvents(f.sha);
          summaries.set(f.sha, summarize(events, { service, date }));
        }
        out.push({ service, date, summary: summaries.get(f.sha) });
      } catch {
        // skip a file that can't be read right now
      }
    };
    for (let i = 0; i < files.length; i += 4) await Promise.all(files.slice(i, i + 4).map(summarizeOne));
    const current = new Set(files.map((f) => f.sha));
    for (const sha of summaries.keys()) if (!current.has(sha)) summaries.delete(sha);
    return { configured: true, files: out };
  }

  return { configured: Boolean(token), load, summarizeAll };
}

module.exports = { createUsageReader };
