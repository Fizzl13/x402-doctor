// One-off: where does the ElizaOS plugin registry live now?
const gh = (u) => fetch(`https://api.github.com/${u}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'fizzl-check' } }).then((r) => r.json());
for (const q of ['registry in:name org:elizaOS', 'registry in:name org:elizaos-plugins', 'elizaos plugin registry in:name,description', 'elizaos registry index.json']) {
  const r = await gh(`search/repositories?q=${encodeURIComponent(q)}&per_page=8`);
  console.log(`\n# ${q}`);
  for (const it of r.items || []) console.log(`  ${it.full_name}  ★${it.stargazers_count}  pushed ${it.pushed_at}  ${it.archived ? 'ARCHIVED ' : ''}${(it.description || '').slice(0, 90)}`);
  if (r.message) console.log('  ', r.message);
}
for (const repo of ['elizaOS/registry', 'elizaos-plugins/registry', 'elizaOS/eliza']) {
  const r = await gh(`repos/${repo}`);
  console.log(`${repo}: ${r.full_name ? `exists, default ${r.default_branch}, archived ${r.archived}` : r.message}`);
}
// How does the eliza CLI find plugins? Look for the registry URL in the CLI source.
const code = await gh(`search/code?q=${encodeURIComponent('registry index.json repo:elizaOS/eliza')}&per_page=5`);
console.log('\ncode search:', code.message || (code.items || []).map((i) => i.path).join(', '));
