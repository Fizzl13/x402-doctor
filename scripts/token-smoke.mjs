// Research: how an agent integrates with Vishwa (read-only: docs and package metadata, nothing installed or run).
async function get(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (research)', accept: 'text/plain,text/markdown,application/json,*/*' } });
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
  } catch (e) { return { status: 'ERR', text: e.cause?.code || e.message }; }
}
const dump = (label, t, max = 7000) => { for (let i = 0; i < Math.min(t.length, max); i += 1800) console.log(label, t.slice(i, i + 1800).replace(/\n/g, ' ⏎ ')); };
const llms = await get('https://vishwalab.com/llms.txt');
console.log('LLMS', llms.status, llms.text.length); dump('LLMS', llms.text, 9000);
const skill = await get('https://api.vishwalab.com/skills/vishwa-cli/skill.md');
console.log('SKILL', skill.status, skill.text.length); dump('SKILL', skill.text, 9000);
const npm = await get('https://registry.npmjs.org/@vishwalab%2fcli');
if (npm.status === 200) {
  const p = JSON.parse(npm.text); const latest = p['dist-tags']?.latest; const v = p.versions?.[latest] || {};
  console.log('NPM', latest, 'created', p.time?.created, 'modified', p.time?.modified, 'versions', Object.keys(p.versions || {}).length);
  console.log('NPM meta', JSON.stringify({ description: v.description, bin: v.bin, deps: v.dependencies, repo: v.repository, license: v.license, scripts: v.scripts }).slice(0, 1500));
  dump('NPM readme', p.readme || '', 5000);
} else console.log('NPM', npm.status);
for (const u of ['https://docs.vishwanetwork.xyz/', 'https://api.vishwalab.com/', 'https://api.vishwalab.com/v1/transfers', 'https://api.vishwalab.com/.well-known/x402', 'https://vishwalab.com/erc']) {
  const r = await get(u);
  console.log('URL', u, r.status, r.type, r.text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 700));
}
