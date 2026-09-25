// One-off: how does ElizaOS find plugins now (registry URL in the CLI / docs)?
const raw = (repo, p) => fetch(`https://raw.githubusercontent.com/${repo}/develop/${p}`).then((r) => (r.ok ? r.text() : null));
const gh = (u) => fetch(`https://api.github.com/${u}`, { headers: { 'user-agent': 'fizzl-check' } }).then((r) => r.json());
const readme = await raw('elizaOS/eliza', 'README.md');
console.log('README lines about plugins/registry:');
for (const l of (readme || '').split('\n')) if (/registry|publish|plugins add|plugin.*(list|submit)/i.test(l)) console.log('  ' + l.trim().slice(0, 200));
const tree = await gh('repos/elizaOS/eliza/git/trees/develop?recursive=1');
const files = (tree.tree || []).map((t) => t.path).filter((p) => /registry/i.test(p) && /\.(ts|md|json)$/.test(p)).slice(0, 25);
console.log('\nfiles with "registry" in the path:\n  ' + files.join('\n  '));
for (const f of files.filter((p) => /cli.*registry.*\.ts$/i.test(p)).slice(0, 4)) {
  const t = await raw('elizaOS/eliza', f);
  const urls = [...new Set((t || '').match(/https?:\/\/[^\s'"`)]+/g) || [])];
  console.log(`\n${f}: ${urls.join(' ')}`);
}
const q = await (await fetch('https://registry.npmjs.org/-/v1/search?text=keywords:elizaos-plugin%20fizzl&size=5')).json();
console.log('\nnpm search "keywords:elizaos-plugin fizzl":', (q.objects || []).map((o) => `${o.package.name}@${o.package.version}`).join(', ') || 'none');
