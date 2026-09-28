// npm versions after publish.
await new Promise((r) => setTimeout(r, 60000));
for (const p of ['x402-safe-fetch', 'plugin-fizzl']) {
  const j = await (await fetch(`https://registry.npmjs.org/${p}`)).json();
  const v = j['dist-tags']?.latest;
  const idx = await (await fetch(`https://unpkg.com/${p}@${v}/${p === 'plugin-fizzl' ? 'package.json' : 'index.js'}`)).text();
  console.log(p, 'latest', v, 'time', j.time?.[v], 'fizzl.eu hits', (idx.match(/fizzl\.eu/g) || []).length, 'onrender hits', (idx.match(/onrender/g) || []).length);
}
