// One-off: x402-trust claim prep for the fizzl.eu hosts (free pages only, never pays). Output is data only. Run 2026-10-01T0620Z.
const text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
for (const h of ['x402-doctor', 'presign-guard', 'ichimoku-signal', 'plaintext']) {
  for (const d of ['fizzl.eu', 'onrender.com']) {
    const host = h === 'plaintext' && d === 'onrender.com' ? 'smartcontractexplainer.onrender.com' : `${h}.${d}`;
    const r = await fetch(`https://${host}/.well-known/x402-trust.txt`).catch((e) => ({ status: e.message, text: async () => '' }));
    const b = (await r.text()).trim();
    console.log(`TXT ${host} → ${r.status} ${b.slice(0, 20)}… (${b.length} chars, same-as-onrender check below)`);
    globalThis[`k_${host}`] = b;
  }
}
for (const h of ['x402-doctor', 'presign-guard', 'ichimoku-signal']) console.log('same key', h, globalThis[`k_${h}.fizzl.eu`] === globalThis[`k_${h}.onrender.com`]);
for (const p of ['/verify', '/submit']) {
  const r = await fetch('https://x402-trust.com' + p, { headers: { 'user-agent': 'x402-doctor-owner-check' } });
  const t = text(await r.text());
  const i = t.search(/Claim|Verify your|verify/);
  console.log(`\n=== ${p} → ${r.status}\n` + t.slice(Math.max(0, t.indexOf('Try it') + 6), Math.max(0, t.indexOf('Try it') + 6) + 3000));
}
