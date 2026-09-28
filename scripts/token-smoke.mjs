// VIRTUAL on Base with presign-guard main as deployed: the token verdict and the raw GoPlus fields,
// for TAT Risk (no payment: the verdict code runs directly). Prints the output as base64 JSON + sha256.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
execSync('git clone -q --depth 1 -b main https://github.com/Fizzl13/presign-guard /tmp/pg && cd /tmp/pg && npm ci -s', { stdio: 'inherit' });
const commit = execSync('git -C /tmp/pg rev-parse HEAD').toString().trim();
const { tokenVerdict } = await import('/tmp/pg/src/token-verdict.js');
const address = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const block = await fetch('https://base-rpc.publicnode.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) }).then((r) => r.json()).then((j) => parseInt(j.result, 16)).catch(() => null);
const verdict = await tokenVerdict({ chain: 'base', address });
const gp = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`).then((r) => r.json());
const t = Object.values(gp.result || {})[0] || {};
const goplus = Object.fromEntries(['is_proxy', 'is_mintable', 'owner_address', 'owner_change_balance', 'hidden_owner', 'can_take_back_ownership', 'transfer_pausable', 'is_blacklisted', 'external_call', 'selfdestruct', 'is_open_source', 'creator_address'].map((k) => [k, t[k]]));
const out = { purpose: 'presign-guard token verdict for VIRTUAL (Base), for TAT Risk', presign_guard_commit: commit, chain: 'base', approx_block: block, takenAt: new Date().toISOString(), verdict, goplus_fields: goplus };
const json = JSON.stringify(out, null, 2) + '\n';
console.log('SUMMARY', commit, block, verdict.grade, verdict.one_liner, JSON.stringify(verdict.reasons.map((r) => `${r.severity}:${r.code}`)));
console.log('GOPLUS', JSON.stringify(goplus));
console.log('SHA256', createHash('sha256').update(json).digest('hex'), json.length);
const b64 = Buffer.from(json).toString('base64');
for (let i = 0; i < b64.length; i += 3000) console.log('B64', i / 3000, b64.slice(i, i + 3000));
