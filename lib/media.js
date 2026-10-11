// Serves the explainer video and its poster from the explainer-video branch,
// and the paid-fix update video from the fix-video branch (both written by
// .github/workflows/explainer-video.yml), so a re-render shows up
// on the homepage without committing video files to the main branch.
//
// Files are downloaded to a temp dir on first use (and at startup) and served
// with sendFile, which supports the byte-range requests iOS Safari needs.
// Until a download finishes, requests are redirected to the raw GitHub URL.
//
// The videos themselves (10-15 MB a view) are sent to jsDelivr, a free CDN for public GitHub repos, pinned to the
// branch's current commit, so a view costs no Render bandwidth. MEDIA_CDN=off serves them from here.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RAW = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/explainer-video';
const FIX_RAW = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/fix-video';
const FILES = {
  'explainer.mp4': { source: 'x402-doctor-explainer.mp4', type: 'video/mp4' },
  'explainer.jpg': { source: 'poster.jpg', type: 'image/jpeg' },
  'explainer.srt': { source: 'x402-doctor-explainer.srt', type: 'text/plain; charset=utf-8' },
  'fix.mp4': { source: 'x402-doctor-fix.mp4', type: 'video/mp4', fix: true },
  'fix.jpg': { source: 'poster.jpg', type: 'image/jpeg', fix: true },
  'fix.srt': { source: 'x402-doctor-fix.srt', type: 'text/plain; charset=utf-8', fix: true },
};
const TTL_MS = 6 * 60 * 60 * 1000;
const CDN = 'https://cdn.jsdelivr.net/gh/Fizzl13/x402-doctor';
const COMMITS = 'https://api.github.com/repos/Fizzl13/x402-doctor/commits';

function createMediaCache({ base = process.env.MEDIA_BASE_URL || RAW, fixBase = process.env.MEDIA_FIX_BASE_URL || FIX_RAW, dir = path.join(os.tmpdir(), 'x402-doctor-media'), fetchImpl = fetch, cdn = process.env.MEDIA_CDN !== 'off' && base === RAW && fixBase === FIX_RAW } = {}) {
  const state = {};
  const loading = {};
  const urlOf = (file) => `${file.fix ? fixBase : base}/${file.source}`;
  const branchOf = (file) => (file.fix ? 'fix-video' : 'explainer-video');

  // The commit a video branch points at now (for the pinned jsDelivr URL), refreshed like the files.
  const commits = {};
  function resolveCommit(branch) {
    const known = commits[branch];
    if (known?.loading || (known?.sha && Date.now() - known.at < TTL_MS)) return;
    commits[branch] = { ...known, loading: true };
    fetchImpl(`${COMMITS}/${branch}`, { headers: { accept: 'application/vnd.github.sha', 'user-agent': 'x402-doctor' }, signal: AbortSignal.timeout(15000) })
      .then(async (res) => {
        const sha = res.ok ? (await res.text()).trim() : '';
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`HTTP ${res.status}`);
        commits[branch] = { sha, at: Date.now() };
      })
      .catch((err) => {
        console.error(`[media] commit of ${branch}: ${err.message}`);
        commits[branch] = { ...known, loading: false };
      });
  }

  function refresh(name) {
    const file = FILES[name];
    if (!file || loading[name]) return loading[name];
    loading[name] = (async () => {
      const res = await fetchImpl(urlOf(file), { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name);
      fs.writeFileSync(`${target}.tmp`, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(`${target}.tmp`, target);
      state[name] = { at: Date.now(), path: target };
    })()
      .catch((err) => console.error(`[media] ${name}: ${err.message}`))
      .finally(() => {
        delete loading[name];
      });
    return loading[name];
  }

  function warm() {
    if (cdn) ['explainer-video', 'fix-video'].forEach(resolveCommit);
    return Promise.all(Object.keys(FILES).map(refresh));
  }

  function handler(req, res) {
    const name = req.params.name;
    const file = FILES[name];
    if (!file) return res.status(404).end();
    if (cdn && file.type === 'video/mp4') {
      const branch = branchOf(file);
      resolveCommit(branch);
      const sha = commits[branch]?.sha;
      if (sha) return res.set('Cache-Control', 'public, max-age=3600').redirect(302, `${CDN}@${sha}/${file.source}`);
    }
    const cached = state[name];
    if (!cached || Date.now() - cached.at > TTL_MS) refresh(name);
    if (!cached) return res.redirect(302, urlOf(file));
    res.set('Cache-Control', 'public, max-age=3600');
    res.type(file.type);
    res.sendFile(cached.path);
  }

  return { handler, warm, refresh };
}

module.exports = { createMediaCache, FILES };
