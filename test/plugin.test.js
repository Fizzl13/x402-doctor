// The plugin marketplace in .claude-plugin/marketplace.json (`/plugin marketplace add Fizzl13/x402-doctor`, and on
// claude.ai Plugins → Add → Add marketplace): three plugins, each a folder with its own .claude-plugin/plugin.json,
// which claude.ai requires (it refused the earlier entries that pointed straight at a skills folder). The Doctor plugin
// is the skills/ folder, so it carries exactly the skills `npx skills add` installs, and its MCP server is the one
// listed in the MCP registry (server.json). presign-guard's is its repository's skills/ folder; `fizzl` is the
// fizzl-skills repository (Agent Wallet, Ichimoku Signal, Fizzl Buy, x402 Forge).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const marketplace = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
const serverJson = JSON.parse(fs.readFileSync(path.join(REPO, 'server.json'), 'utf8'));
const byName = Object.fromEntries(marketplace.plugins.map((p) => [p.name, p]));

test('plugin marketplace: named fizzl, three plugins with kebab-case names', () => {
  assert.equal(marketplace.name, 'fizzl');
  assert.ok(marketplace.owner.name);
  assert.deepEqual(Object.keys(byName).sort(), ['fizzl', 'presign-guard', 'x402-doctor']);
  for (const name of Object.keys(byName)) assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('plugin x402-doctor: the skills/ folder with its own manifest, every skill in it, and the registry MCP server', () => {
  const doctor = byName['x402-doctor'];
  assert.equal(doctor.source, './skills');
  const root = path.join(REPO, doctor.source);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'x402-doctor');
  assert.deepEqual(manifest.skills, ['./']);
  assert.ok(manifest.privacyPolicyUrl, 'claude.ai asks a privacy policy for a plugin with a remote MCP server');
  assert.ok(fs.existsSync(path.join(root, manifest.icon)), 'the icon file exists');
  const skills = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'SKILL.md')));
  assert.deepEqual(skills.sort(), ['x402-preflight', 'x402-seller-check']);
  assert.ok(!fs.existsSync(path.join(root, 'bin')), 'no bin/ in the plugin root');
  assert.deepEqual(manifest.mcpServers, { 'x402-doctor': { type: 'http', url: serverJson.remotes[0].url } });
});

test('plugins presign-guard and fizzl: from their own repositories', () => {
  assert.deepEqual(byName['presign-guard'].source, { source: 'git-subdir', url: 'https://github.com/Fizzl13/presign-guard.git', path: 'skills' });
  assert.deepEqual(byName.fizzl.source, { source: 'github', repo: 'Fizzl13/fizzl-skills' });
});
