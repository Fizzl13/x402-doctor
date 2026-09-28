// Research: is the fizzl.eu direct-tool-link change live (tools.js with openFromHash)?
for (let i = 0; i < 12; i++) {
  const t = await (await fetch(`https://fizzl.eu/tools.js?t=${Date.now()}`, { cache: 'no-store' })).text();
  const live = t.includes('openFromHash');
  console.log(new Date().toISOString(), 'tools.js live:', live);
  if (live) break;
  await new Promise((s) => setTimeout(s, 15000));
}
