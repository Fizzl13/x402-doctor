// One-off: x402-trust grades for the fizzl services (free pages only, never pays). Output is data only. Run 2026-10-01T0600Z.
const BASE = 'https://x402-trust.com';
const text = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const hosts = ['x402-doctor.fizzl.eu', 'presign-guard.fizzl.eu', 'ichimoku-signal.fizzl.eu', 'plaintext.fizzl.eu',
  'x402-doctor.onrender.com', 'presign-guard.onrender.com', 'ichimoku-signal.onrender.com', 'smartcontractexplainer.onrender.com'];
for (const h of hosts) {
  const res = await fetch(`${BASE}/providers/${h}`, { headers: { 'user-agent': 'x402-doctor-owner-check' } });
  const body = await res.text();
  console.log(`\n=== ${h} → ${res.status}`);
  if (!res.ok) continue;
  console.log(text(body).replace(/^.*?(?=Grade|grade|Score|score)/, '').slice(0, 2200));
}
