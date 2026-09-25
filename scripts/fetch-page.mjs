// One-off: how does the ElizaOS plugin registry list plugins, and is plugin-fizzl in it?
const raw = (p) => fetch(`https://raw.githubusercontent.com/elizaos-plugins/registry/main/${p}`).then((r) => (r.ok ? r.text() : `HTTP ${r.status}`));
const index = await raw('index.json');
let j = null;
try { j = JSON.parse(index); } catch { console.log('index.json not JSON:', index.slice(0, 300)); }
if (j) {
  const keys = Object.keys(j);
  console.log(`index.json: ${keys.length} entries; sample:`);
  for (const k of keys.slice(0, 3).concat(keys.filter((k) => /\/plugin-(solana|coingecko|x402|bnb)/.test(k)).slice(0, 4))) console.log(`  ${JSON.stringify(k)}: ${JSON.stringify(j[k])}`);
  console.log('fizzl entries:', keys.filter((k) => /fizzl/i.test(k) || /fizzl/i.test(JSON.stringify(j[k]))));
  const sorted = keys.every((k, i) => i === 0 || keys[i - 1].localeCompare(k) <= 0);
  console.log('sorted alphabetically:', sorted);
}
for (const f of ['README.md', 'CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md', 'schema.json']) {
  const t = await raw(f);
  console.log(`\n===== ${f} =====\n${t.slice(0, 3500)}`);
}
const tree = await (await fetch('https://api.github.com/repos/elizaos-plugins/registry/contents/')).json();
console.log('\nroot files:', Array.isArray(tree) ? tree.map((x) => x.name).join(', ') : JSON.stringify(tree).slice(0, 200));
