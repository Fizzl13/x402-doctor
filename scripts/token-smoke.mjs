// Live check: Ichimoku /setups/preview with the 7-day history, and the homepage.
const base = 'https://ichimoku-signal.onrender.com';
let t = Date.now();
const r = await fetch(`${base}/setups/preview`, { signal: AbortSignal.timeout(180000) });
const secs = ((Date.now() - t) / 1000).toFixed(1);
const body = await r.json().catch(() => null);
console.log('preview', r.status, `${secs}s`);
if (body) {
  console.log('setup', body.setup && body.setup.pair, JSON.stringify(body.since));
  for (const h of body.history || []) console.log(h.ranked_hours_ago, h.pair, h.direction, JSON.stringify(h.since));
  console.log('summary', JSON.stringify(body.history_summary));
}
t = Date.now();
const r2 = await fetch(`${base}/setups/preview`);
console.log('preview again (cache)', r2.status, `${((Date.now() - t) / 1000).toFixed(1)}s`);
const html = await (await fetch(base, { headers: { accept: "text/html" } })).text();
console.log('homepage preview-history', html.includes('id="preview-history"'));
if (!body || (body.history || []).length !== 7 || !body.history_summary || !html.includes('id="preview-history"')) process.exit(1);
