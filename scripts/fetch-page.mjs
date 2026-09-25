// One-off: x402.org ecosystem entries (clone the site folder; the API is rate limited here).
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
sh('git clone -q --depth 1 --filter=blob:none --sparse https://github.com/coinbase/x402 /tmp/x402');
sh('cd /tmp/x402 && git sparse-checkout set typescript/site/app/ecosystem typescript/site/public/logos');
const readme = fs.readFileSync('/tmp/x402/typescript/site/README.md', 'utf8');
console.log(readme.slice(readme.indexOf('## Adding Your Project'), readme.indexOf('## Adding Your Project') + 3000));
const base = '/tmp/x402/typescript/site/app/ecosystem/partners-data';
const dirs = fs.readdirSync(base);
console.log(`\n${dirs.length} entries`);
const cats = {};
const metas = [];
for (const d of dirs) {
  try { const m = JSON.parse(fs.readFileSync(path.join(base, d, 'metadata.json'), 'utf8')); metas.push([d, m]); cats[m.category] = (cats[m.category] || 0) + 1; } catch {}
}
console.log('categories:', JSON.stringify(cats));
console.log('keys used:', [...new Set(metas.flatMap(([, m]) => Object.keys(m)))].join(', '));
for (const [d, m] of metas.filter(([d, m]) => /signal|trading|security|guard|doctor|debug|eliza|plugin|mcp/i.test(d + JSON.stringify(m))).slice(0, 5)) console.log(`\n--- ${d}\n${JSON.stringify(m, null, 2)}`);
console.log('\nalready listed:', metas.filter(([d, m]) => /fizzl|ichimoku|x402-doctor|presign/i.test(d + JSON.stringify(m))).map(([d]) => d));
const logos = fs.readdirSync('/tmp/x402/typescript/site/public/logos');
console.log('\nlogos:', logos.length, logos.slice(0, 8).join(', '));
const sizes = logos.slice(0, 40).map((f) => { try { const b = fs.readFileSync(`/tmp/x402/typescript/site/public/logos/${f}`); if (b[1] === 0x50) return `${f} ${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`; return `${f} ${b.length}B`; } catch { return f; } });
console.log('logo sizes:', sizes.join(' | '));
const other = fs.readdirSync('/tmp/x402/typescript/site/app/ecosystem').filter((f) => f !== 'partners-data');
console.log('\necosystem folder:', other.join(', '));
for (const f of other.filter((f) => /\.(ts|tsx)$/.test(f))) { const t = fs.readFileSync(`/tmp/x402/typescript/site/app/ecosystem/${f}`, 'utf8'); const m = t.match(/categor[^\n]*\n(?:[^\n]*\n){0,12}/i); if (m) console.log(`\n${f}:\n${m[0]}`); }
