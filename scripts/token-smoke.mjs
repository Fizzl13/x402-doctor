// Which upstream URL does Smithery hold per server?
for (const s of ['x402-doctor', 'presign-guard', 'ichimoku-signal', 'plaintext']) {
  const r = await fetch(`https://registry.smithery.ai/servers/frits-zwager/${s}`, { headers: { accept: 'application/json' } });
  const t = await r.text();
  console.log('==', s, r.status);
  let j; try { j = JSON.parse(t); } catch { console.log(t.slice(0, 300)); continue; }
  const { tools, ...rest } = j;
  console.log(JSON.stringify(rest).slice(0, 1500));
  console.log('urls:', [...new Set(t.match(/https:\/\/[a-z0-9.-]+\.(onrender\.com|fizzl\.eu|run\.tools)[^"]*/g) || [])].join(' '));
}
