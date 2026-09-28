// Smithery listing check: homepage/repo and tools per server.
for (const s of ['x402-doctor', 'presign-guard', 'ichimoku-signal', 'plaintext']) {
  const r = await fetch(`https://registry.smithery.ai/servers/frits-zwager/${s}`, { headers: { accept: 'application/json' } });
  const t = await r.text();
  console.log('==', s, r.status);
  let j; try { j = JSON.parse(t); } catch { console.log(t.slice(0, 300)); continue; }
  const { tools, description, ...rest } = j;
  console.log(JSON.stringify(rest).slice(0, 800));
  console.log('description:', description);
  console.log('tools:', (tools || []).map((x) => x.name).join(', '));
  const page = await (await fetch(`https://smithery.ai/servers/frits-zwager/${s}`)).text();
  console.log('page urls:', [...new Set(page.match(/https?:\/\/[a-z0-9.-]*(fizzl\.eu|onrender\.com|github\.com\/fizzl13[^"'<\s]*)/gi) || [])].join(' '));
}
