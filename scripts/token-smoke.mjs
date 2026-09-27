// Live: Rider x402 (Slid Phi Labs) discovery, then Doctor's report on a few of its endpoints.
const base = 'https://rider-x402.fly.dev';
const get = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: e.message }; } };
for (const p of ['/', '/.well-known/x402', '/openapi.json']) {
  const r = await get(base + p);
  console.log(`== ${p} HTTP ${r.status}\n${r.text.slice(0, 2500)}`);
}
let urls = [base + '/'];
try {
  const wk = JSON.parse((await get(base + '/.well-known/x402')).text);
  const list = (wk.resources || wk.endpoints || wk.items || []).map((x) => (typeof x === 'string' ? x : x.resource || x.url)).filter(Boolean);
  urls = [...new Set([...list.slice(0, 4), base + '/'])].map((u) => (u.startsWith('http') ? u : base + u));
} catch {}
for (const url of urls) {
  const r = await fetch('https://x402-doctor.onrender.com/api/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(120000) });
  const d = await r.json().catch(() => ({}));
  console.log(`\n## Doctor ${url}: HTTP ${r.status} overall ${d.overall}`);
  for (const c of d.checks || []) if (c.status !== 'pass') console.log(c.status, c.id, '|', c.message);
  await new Promise((res) => setTimeout(res, 1500));
}
