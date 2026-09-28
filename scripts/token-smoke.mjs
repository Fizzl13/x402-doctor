// EntRoute: submission status; retry /v1/check once presign-guard is verified; look for a verify endpoint.
const API = 'https://api.entroute.com';
const subs = { 'x402-doctor': '16625e28-6c96-446e-8610-ddbf7c3b7b2e', 'presign-guard': '4bcddc6c-3c0d-42e8-833a-1cbb1badc08b', 'ichimoku-signal': '79b6aca8-d398-4500-87ff-0e7f863e8496' };
const st = {};
for (const [h, id] of Object.entries(subs)) {
  const r = await fetch(`${API}/submit/${id}`, { headers: { accept: 'application/json' } });
  const t = await r.text(); st[h] = t;
  console.log('status', h, r.status, t.slice(0, 400));
}
const verified = (t) => /"claim_status":"(verified|approved|claimed)"|"status":"(verified|approved|listed|live|probing)"/.test(t);
if (verified(st['presign-guard'])) {
  const r = await fetch(`${API}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ endpoint_url: 'https://presign-guard.fizzl.eu/v1/check', capability_id: 'security.compliance_check', contact_email: 'Fizzl13@protonmail.com', provider_name: 'presign-guard', price_per_call: 0.01 }) });
  console.log('retry /v1/check', r.status, (await r.text()).slice(0, 500));
} else console.log('presign-guard not verified yet: no retry');
// Does the API document a way to trigger verification?
for (const u of ['https://entroute.com/docs', 'https://entroute.com/docs/api', 'https://api.entroute.com/', 'https://api.entroute.com/openapi.json', 'https://entroute.com/llms.txt']) {
  try {
    const r = await fetch(u, { headers: { accept: 'application/json, text/html, text/plain' } });
    const t = await r.text();
    const hits = [...new Set((t.match(/[^\n"<>]{0,90}(verif|claim)[^\n"<>]{0,120}/gi) || []))].slice(0, 8);
    console.log('==', u, r.status, t.length); for (const h of hits) console.log('   ', h.trim());
  } catch (e) { console.log('==', u, 'ERR', e.message); }
}
for (const [m, path] of [['POST', '/submit/4bcddc6c-3c0d-42e8-833a-1cbb1badc08b/verify'], ['POST', '/verify/4bcddc6c-3c0d-42e8-833a-1cbb1badc08b'], ['GET', '/claims/df234f5a-64b8-4915-bf67-6c8e5d1c4efa']]) {
  const r = await fetch(API + path, { method: m, headers: { accept: 'application/json' } });
  console.log('probe', m, path, r.status, (await r.text()).slice(0, 200));
}
