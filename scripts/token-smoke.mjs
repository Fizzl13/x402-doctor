// EntRoute re-check: submission status and whether the endpoints show up in discovery (read-only). Output is data only.
const IDS = { doctor: '16625e28-6c96-446e-8610-ddbf7c3b7b2e', presign: '4bcddc6c-3c0d-42e8-833a-1cbb1badc08b', ichimoku: '79b6aca8-d398-4500-87ff-0e7f863e8496' };
for (const [k, id] of Object.entries(IDS)) {
  try { const r = await fetch(`https://api.entroute.com/submit/${id}`, { headers: { accept: 'application/json' } }); console.log(`STATUS ${k} ${r.status} ${(await r.text()).slice(0, 500)}`); } catch (e) { console.log(`STATUS ${k} ERR ${e.message}`); }
}
for (const cap of ['security.api_health', 'crypto.risk_intelligence', 'finance.trending']) {
  try { const r = await fetch(`https://api.entroute.com/capabilities/${cap}?with_endpoints=true`, { headers: { accept: 'application/json' } }); const t = await r.text(); console.log(`CAP ${cap} ${r.status} fizzl=${/fizzl\.eu/.test(t)} ${t.slice(0, 300)}`); } catch (e) { console.log(`CAP ${cap} ERR ${e.message}`); }
}
