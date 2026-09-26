// x402-trust.com: endpoint pages for our services + how the score is built (free pages only, nothing paid).
const BASE = 'https://x402-trust.com';
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/\s+/g, ' ');
async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'user-agent': 'x402-doctor-owner-check' } });
  const body = await res.text();
  console.log(`\n=== ${path} → HTTP ${res.status}`);
  return { res, body };
}
const grab = (t, re, n) => { const i = t.search(re); return i >= 0 ? t.slice(i, i + n) : '(not found)'; };
const d = await get('/endpoint/153087');
{ const t = text(d.body); console.log(t.slice(t.indexOf('home ›'), t.indexOf('home ›') + 4000)); console.log('\nFLAGS PART:', grab(t, /error flag|Why this verdict/i, 3000)); }
const flagCodes = [...new Set([...d.body.matchAll(/data-flag="([^"]+)"|"code":"([^"]+)"/g)].map((m) => m[1] || m[2]))];
console.log('flag codes in HTML:', flagCodes.join(', '));
for (const host of ['presign-guard.onrender.com', 'ichimoku-signal.onrender.com', 'plaintext-contracts.onrender.com']) {
  const { res, body } = await get(`/provider/${host}`);
  if (res.ok) console.log(grab(text(body), /All endpoints/, 1500));
}
for (const p of ['/llms.txt', '/failure-modes', '/verify']) {
  const { body } = await get(p);
  const t = p === '/llms.txt' ? body : text(body);
  console.log(grab(t, /weight|breakdown|score is|how we score|scoring/i, 5000));
  if (p === '/verify') console.log(t.slice(0, 3000));
}
