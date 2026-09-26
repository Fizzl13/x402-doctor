// One-off: what x402-trust.com says about x402-doctor.onrender.com (free pages only, nothing paid).
const BASE = 'https://x402-trust.com';
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
async function get(path) {
  const res = await fetch(path.startsWith('http') ? path : BASE + path, { headers: { 'user-agent': 'x402-doctor-owner-check' } });
  const body = await res.text();
  console.log(`\n=== ${path} → HTTP ${res.status} (${body.length} bytes)`);
  return { res, body };
}
const home = await get('/');
const links = [...new Set([...home.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];
console.log('home links:', links.filter((l) => !/\.(css|png|svg|ico|js)$/.test(l)).slice(0, 60).join(' '));
for (const p of ['/providers/x402-doctor.onrender.com', '/provider/x402-doctor.onrender.com', '/p/x402-doctor.onrender.com']) {
  const { res, body } = await get(p);
  if (!res.ok) continue;
  const eps = [...new Set([...body.matchAll(/href="([^"]*(?:endpoint|\/e\/)[^"]*)"/g)].map((m) => m[1]))];
  console.log('endpoint links:', eps.join(' '));
  console.log(text(body).slice(0, 3000));
  for (const e of eps.filter((e) => /preflight|diagnose|fix/.test(decodeURIComponent(e))).slice(0, 4)) {
    const r = await get(e);
    const t = text(r.body);
    const i = t.search(/Why this verdict/i);
    console.log(t.slice(0, 1800));
    if (i >= 0) console.log('VERDICT PART:', t.slice(i, i + 2500));
  }
  break;
}
for (const p of ['/trust/stats', '/v1/x402-trust-preview']) {
  const { body } = await get(p);
  console.log(body.slice(0, 6000));
}
