// The Agent Skills in skills/ (installable with `npx skills add Fizzl13/x402-doctor`): valid frontmatter per the
// Agent Skills format, and every Doctor route they tell an agent to call exists on the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'skills');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'lib', 'paid-api.js'), 'utf8');
const skills = fs.readdirSync(ROOT).filter((d) => fs.existsSync(path.join(ROOT, d, 'SKILL.md')));

test('skills: both are there', () => {
  assert.deepEqual(skills.sort(), ['x402-preflight', 'x402-seller-check']);
});

for (const dir of skills) {
  const text = fs.readFileSync(path.join(ROOT, dir, 'SKILL.md'), 'utf8');

  test(`${dir}: frontmatter name matches the folder, description within 1024 characters`, () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, 'starts with YAML frontmatter');
    const name = /^name:\s*(.+)$/m.exec(front[1])[1].trim();
    assert.equal(name, dir);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    const description = JSON.parse(/^description:\s*(".*")$/m.exec(front[1])[1]);
    assert.ok(description.length > 50 && description.length <= 1024, `description is ${description.length} characters`);
  });

  test(`${dir}: every Doctor route it names exists`, () => {
    const routes = [...text.matchAll(/x402-doctor\.fizzl\.eu(\/api\/[a-z0-9/_-]+)/g)].map((m) => m[1]);
    assert.ok(routes.length >= 2);
    for (const route of new Set(routes)) {
      assert.ok(server.includes(`'${route}'`), `${route} is served`);
    }
  });
}
