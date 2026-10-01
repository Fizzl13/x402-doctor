// One-off: x402-trust grades for the fizzl services (free pages only, never pays). Output is data only. Run 2026-10-01T0605Z.
const BASE = 'https://x402-trust.com';
const UA = { headers: { 'user-agent': 'x402-doctor-owner-check' } };
const text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const get = async (p) => { const r = await fetch(p.startsWith('http') ? p : BASE + p, UA); return { status: r.status, body: await r.text() }; };
const links = (b) => [...new Set([...b.matchAll(/href="([^"]+)"/g)].map((m) => m[1]))];
const home = await get('/');
console.log('home links:', links(home.body).filter((l) => !/\.(css|png|svg|ico|js)$/.test(l)).join(' '));
const pages = new Set();
for (const p of ['/providers', '/by-provider', '/leaderboard', '/explore', '/browse/providers']) {
  const r = await get(p);
  const mine = links(r.body).filter((l) => /fizzl|onrender|doctor|presign|ichimoku|plaintext|smartcontract/i.test(l));
  console.log(`${p} → ${r.status} ${r.body.length}b; mine: ${mine.join(' ')}`);
  mine.forEach((l) => pages.add(l));
}
for (const p of [...pages].slice(0, 12)) {
  const r = await get(p);
  console.log(`\n=== ${p} → ${r.status}`);
  console.log(text(r.body).slice(0, 2500));
}
