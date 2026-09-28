// Which base URL does live presign-guard advertise?
for (const u of ['https://presign-guard.fizzl.eu/openapi.json', 'https://presign-guard.fizzl.eu/.well-known/x402', 'https://presign-guard.fizzl.eu/']) {
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  const t = await r.text();
  console.log('==', u, r.status, 'onrender:', (t.match(/onrender\.com/g) || []).length, 'fizzl.eu:', (t.match(/fizzl\.eu/g) || []).length);
  console.log([...new Set(t.match(/https:\/\/[a-z0-9.-]+(onrender\.com|fizzl\.eu)/g) || [])].join(' '));
}
