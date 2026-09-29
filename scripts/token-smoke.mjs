// EntRoute re-check: submission status, the TXT records, and the verification docs (read-only). Output is data only.
const IDS = { doctor: '16625e28-6c96-446e-8610-ddbf7c3b7b2e', presign: '4bcddc6c-3c0d-42e8-833a-1cbb1badc08b', ichimoku: '79b6aca8-d398-4500-87ff-0e7f863e8496' };
const presignStatus = {};
for (const [k, id] of Object.entries(IDS)) {
  try { const r = await fetch(`https://api.entroute.com/submit/${id}`, { headers: { accept: 'application/json' } }); const t = await r.text(); presignStatus[k] = t; console.log(`STATUS ${k} ${r.status} ${t.slice(0, 700)}`); } catch (e) { console.log(`STATUS ${k} ERR ${e.message}`); }
}
for (const h of ['x402-doctor', 'presign-guard', 'ichimoku-signal']) {
  try { const r = await fetch(`https://dns.google/resolve?name=_entroute.${h}.fizzl.eu&type=TXT`); const j = await r.json(); console.log(`TXT ${h} ${JSON.stringify((j.Answer || []).map((a) => a.data))}`); } catch (e) { console.log(`TXT ${h} ERR ${e.message}`); }
}
try {
  const t = await (await fetch('https://entroute.com/docs/verification')).text();
  console.log('DOCS ' + t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3500));
} catch (e) { console.log(`DOCS ERR ${e.message}`); }
