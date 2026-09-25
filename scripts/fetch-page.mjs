// One-off: how does x402.org list ecosystem projects (coinbase/x402)?
const gh = (u) => fetch(`https://api.github.com/${u}`, { headers: { 'user-agent': 'fizzl-check' } }).then((r) => r.json());
const raw = (p, ref = 'main') => fetch(`https://raw.githubusercontent.com/coinbase/x402/${ref}/${p}`).then((r) => (r.ok ? r.text() : `HTTP ${r.status}`));
const repo = await gh('repos/coinbase/x402');
console.log('repo:', repo.full_name, 'default', repo.default_branch, 'archived', repo.archived);
const ref = repo.default_branch || 'main';
const tree = await gh(`repos/coinbase/x402/git/trees/${ref}?recursive=1`);
const paths = (tree.tree || []).map((t) => t.path);
const eco = paths.filter((p) => /ecosystem|partners/i.test(p));
const dirs = [...new Set(eco.map((p) => p.split('/').slice(0, -1).join('/')))];
console.log('ecosystem dirs (first 15):\n  ' + dirs.slice(0, 15).join('\n  '));
console.log('ecosystem file count:', eco.length);
const meta = eco.filter((p) => /metadata\.json$/.test(p));
console.log('metadata.json files:', meta.length);
for (const p of meta.filter((p) => /doctor|signal|trading|security|guard|plugin|eliza/i.test(p)).slice(0, 3).concat(meta.slice(0, 2))) console.log(`\n--- ${p}\n${await raw(p, ref)}`);
const categories = new Set();
for (const p of meta.slice(0, 400)) { try { categories.add(JSON.parse(await raw(p, ref)).category); } catch {} }
console.log('\ncategories:', [...categories].join(' | '));
console.log('\nfizzl/ichimoku already listed:', meta.filter((p) => /fizzl|ichimoku|x402-doctor|presign/i.test(p)));
for (const f of ['CONTRIBUTING.md', 'typescript/site/CONTRIBUTING.md', 'typescript/site/README.md']) {
  const t = await raw(f, ref);
  const i = t.search(/ecosystem/i);
  console.log(`\n===== ${f} =====\n${i >= 0 ? t.slice(Math.max(0, i - 300), i + 2500) : t.slice(0, 300)}`);
}
const logos = eco.filter((p) => /\.(png|svg|jpg|webp)$/.test(p)).slice(0, 5);
console.log('\nlogo examples:', logos.join(', '));
