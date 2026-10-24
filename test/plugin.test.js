// The Claude Code plugin marketplace in .claude-plugin/marketplace.json (`/plugin marketplace add Fizzl13/x402-doctor`):
// the Doctor plugin is the skills/ folder itself, so it carries exactly the skills `npx skills add` installs, and its
// MCP server is the one listed in the MCP registry (server.json). The wallet, Ichimoku and Fizzl Buy plugins come from
// the fizzl-skills repository, one skill each.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const marketplace = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
const serverJson = JSON.parse(fs.readFileSync(path.join(REPO, 'server.json'), 'utf8'));
const byName = Object.fromEntries(marketplace.plugins.map((p) => [p.name, p]));

test('plugin marketplace: named fizzl, five plugins with kebab-case names', () => {
  assert.equal(marketplace.name, 'fizzl');
  assert.ok(marketplace.owner.name);
  assert.deepEqual(Object.keys(byName).sort(), ['fizzl-agent-wallet', 'fizzl-buy', 'ichimoku-signal', 'presign-guard', 'x402-doctor']);
  for (const name of Object.keys(byName)) assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('plugin x402-doctor: the skills/ folder, every skill in it, and the registry MCP server', () => {
  const doctor = byName['x402-doctor'];
  assert.equal(doctor.source, './skills');
  assert.deepEqual(doctor.skills, ['./']);
  const root = path.join(REPO, doctor.source);
  const skills = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'SKILL.md')));
  assert.deepEqual(skills.sort(), ['x402-preflight', 'x402-seller-check']);
  assert.ok(!fs.existsSync(path.join(root, 'bin')), 'no bin/ in the plugin root');
  assert.deepEqual(doctor.mcpServers, { 'x402-doctor': { type: 'http', url: serverJson.remotes[0].url } });
});

test('plugin presign-guard: its repository skills/ folder and its MCP server', () => {
  const guard = byName['presign-guard'];
  assert.deepEqual(guard.source, { source: 'git-subdir', url: 'https://github.com/Fizzl13/presign-guard.git', path: 'skills' });
  assert.deepEqual(guard.skills, ['./']);
  assert.deepEqual(guard.mcpServers, { 'presign-guard': { type: 'http', url: 'https://presign-guard.fizzl.eu/mcp' } });
});

test('plugins fizzl-agent-wallet, ichimoku-signal and fizzl-buy: one skill each from fizzl-skills, Ichimoku and Fizzl Buy with their MCP servers', () => {
  const src = { source: 'git-subdir', url: 'https://github.com/Fizzl13/fizzl-skills.git', path: 'skills' };
  const wallet = byName['fizzl-agent-wallet'];
  assert.deepEqual(wallet.source, src);
  assert.deepEqual(wallet.skills, ['./agent-wallet-limits']);
  assert.equal(wallet.mcpServers, undefined, 'the wallet MCP server needs the owner\'s keys');
  const ichimoku = byName['ichimoku-signal'];
  assert.deepEqual(ichimoku.source, src);
  assert.deepEqual(ichimoku.skills, ['./crypto-trend-signal']);
  assert.deepEqual(ichimoku.mcpServers, { 'ichimoku-signal': { type: 'http', url: 'https://ichimoku-signal.fizzl.eu/mcp' } });
  const buy = byName['fizzl-buy'];
  assert.deepEqual(buy.source, src);
  assert.deepEqual(buy.skills, ['./buy-live-data']);
  assert.deepEqual(buy.mcpServers, { 'fizzl-buy': { type: 'http', url: 'https://buy.fizzl.eu/mcp' } });
});
