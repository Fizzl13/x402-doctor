// Every failed or warning check Doctor can write has a fix recipe (lib/recipes.js), so the paid fix (GET /api/v1/fix)
// covers all of them. Reads each addCheck(checks, id, 'fail' | 'warn', message) in lib/ and asks the recipes with that
// id and message. A new check without a recipe fails here; ALLOWED lists the ones that are not a seller's mistake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RECIPES } = require('../lib/recipes');

const ALLOWED = new Set([
  'returns-402 warn', // a free trial answered: nothing the seller got wrong, and nothing to fix
]);

function checksInSource() {
  const dir = path.join(__dirname, '..', 'lib');
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const re = /addCheck\(\s*checks,\s*(['`])((?:\\.|(?!\1).)+)\1,\s*(?:'(fail|warn)'|([a-zA-Z_.?:' ]+?)),\s*(['`"])((?:\\.|(?!\5)[\s\S])*?)\5/g;
    let m;
    while ((m = re.exec(src))) {
      const id = m[2].replace(/\$\{[^}]*\}/g, '0').replace(/^0-/, 'accepts[0]-');
      const statuses = m[3] ? [m[3]] : ['fail', 'warn'].filter((s) => (m[4] || '').includes(s));
      const message = m[6].replace(/\$\{[^}]*\}/g, 'X');
      for (const status of statuses) out.push({ file, id, status, message });
    }
  }
  return out;
}

test('the source has checks to read (the pattern still finds them)', () => {
  assert.ok(checksInSource().length > 150);
});

test('every failed or warning check has a recipe', () => {
  const missing = checksInSource()
    .filter((c) => !ALLOWED.has(`${c.id} ${c.status}`))
    .filter((c) => !RECIPES.some((r) => { try { return r.match({ ...c, option: 0 }); } catch { return false; } }))
    .map((c) => `${c.file}: ${c.id} [${c.status}] ${c.message.slice(0, 90)}`);
  assert.deepEqual(missing, []);
});
