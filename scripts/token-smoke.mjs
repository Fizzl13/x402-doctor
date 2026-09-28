// agent-tools.cloud submit schema.
for (const u of ['https://agent-tools.cloud/openapi.json', 'https://agent-tools.cloud/api/openapi.json', 'https://agent-tools.cloud/docs/openapi.json']) {
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  const t = await r.text();
  console.log('==', u, r.status, t.length);
  if (!r.ok) continue;
  try {
    const j = JSON.parse(t);
    const op = j.paths?.['/api/v1/submit'];
    console.log(JSON.stringify(op, null, 1).slice(0, 3000));
    for (const [k, v] of Object.entries(j.components?.schemas || {})) if (/submi/i.test(k)) console.log(k, JSON.stringify(v).slice(0, 3000));
  } catch (e) { console.log(t.slice(0, 300)); }
  break;
}
const page = await (await fetch('https://agent-tools.cloud/submit', { headers: { accept: 'text/html' } })).text();
console.log('== form names:', [...new Set([...page.matchAll(/name=["']([a-z_]+)["']/gi)].map((m) => m[1]))].join(' '));
const scripts = [...page.matchAll(/fetch\([^)]*submit[^)]*\)[\s\S]{0,600}/g)].map((m) => m[0]).slice(0, 2);
console.log(scripts.join('\n----\n'));
