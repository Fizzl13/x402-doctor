// Compares Claude models on the three Claude calls in presign-guard and Doctor, through their real code:
//   1. presign-guard explain(): the plain-language explanation of a check result (README examples, en + nl);
//   2. presign-guard jev.js askClaude(): true/false phishing questions as JSON;
//   3. Doctor lib/jev-triage.js: the { test, real } call when Jev is unsure (Jev's answer is faked here).
// A fetch wrapper swaps the model and thinking settings per variant and times each call. The code's own
// timeouts and parsing stay as they are, so a variant that breaks shows up as a failure here too.
//
// Needs ANTHROPIC_API_KEY and a presign-guard checkout (PG_DIR, with npm ci done). Spends real tokens:
// about 100 short calls, well under $0.20. Prints a Markdown report (also to $GITHUB_STEP_SUMMARY).
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createTriage } = require('../lib/jev-triage');

const KEY = process.env.ANTHROPIC_API_KEY;
const PG_DIR = path.resolve(process.env.PG_DIR || '../presign-guard');
if (!KEY) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(1); }
const REPEAT = Number(process.env.REPEAT || 2);

const pg = await import(pathToFileURL(path.join(PG_DIR, 'src/presign-guard.js')).href);
const jev = await import(pathToFileURL(path.join(PG_DIR, 'src/jev.js')).href);

// Per variant: what changes in the request body. maxTokens(n) gets the code's own max_tokens.
const VARIANTS = [
  { id: 'h45', label: 'Haiku 4.5 (now)', model: 'claude-haiku-4-5-20251001', price: [1, 5] },
  { id: 'h55-swap', label: 'Haiku 5.5, model swap only', model: 'claude-haiku-5-5', price: [0.1, 0.5] },
  { id: 'h55-low', label: 'Haiku 5.5, effort low, +1000 max_tokens', model: 'claude-haiku-5-5', price: [0.1, 0.5], output_config: { effort: 'low' }, maxTokens: (n) => n + 1000 },
  { id: 'h55-off', label: 'Haiku 5.5, thinking off, effort low', model: 'claude-haiku-5-5', price: [0.1, 0.5], output_config: { effort: 'low' }, thinking: { type: 'disabled' } },
];

const calls = []; // { route, variant, sample, ms, status, stop, inTok, outTok, types, text, error }
let current = null; // { route, variant, sample }
const realFetch = globalThis.fetch;

function wrapped(fakeJev = null) {
  return async (url, init = {}) => {
    const u = String(url);
    if (fakeJev && u.startsWith('https://api.typesafe.ai/')) return new Response(JSON.stringify(fakeJev), { status: 200, headers: { 'content-type': 'application/json' } });
    if (!u.startsWith('https://api.anthropic.com/v1/messages')) return realFetch(url, init);
    const v = current.variant;
    const body = JSON.parse(init.body);
    body.model = v.model;
    if (v.maxTokens) body.max_tokens = v.maxTokens(body.max_tokens);
    if (v.output_config) body.output_config = v.output_config;
    if (v.thinking) body.thinking = v.thinking;
    const rec = { route: current.route, variant: v.id, sample: current.sample, maxTokens: body.max_tokens };
    calls.push(rec);
    const t0 = Date.now();
    try {
      const res = await realFetch(url, { ...init, headers: { ...init.headers, 'x-api-key': KEY }, body: JSON.stringify(body) });
      const text = await res.text();
      rec.ms = Date.now() - t0;
      rec.status = res.status;
      try {
        const j = JSON.parse(text);
        rec.stop = j.stop_reason;
        rec.inTok = j.usage?.input_tokens ?? 0;
        rec.outTok = j.usage?.output_tokens ?? 0;
        rec.types = (j.content || []).map((b) => b.type).join('+');
        rec.text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (!res.ok) rec.error = j.error?.message?.slice(0, 160);
      } catch { rec.error = text.slice(0, 160); }
      return new Response(text, { status: res.status, headers: res.headers });
    } catch (err) {
      rec.ms = Date.now() - t0;
      rec.error = `${err.name}`;
      throw err;
    }
  };
}

// ---------- samples ----------

// 1. explain(): the example check results in presign-guard's README.
const readme = readFileSync(path.join(PG_DIR, 'README.md'), 'utf8');
const results = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
  .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
  .filter((j) => j && typeof j.verdict === 'string' && Array.isArray(j.reasons))
  .slice(0, 4);
if (results.length < 2) throw new Error(`only ${results.length} example results found in the README`);

// 2. jev.js askClaude(): inputs with a known right answer per question.
const RANDOM = '0x1111111111111111111111111111111111111111';
const jevSamples = [
  { name: 'airdrop lookalike + fake USDC', input: { chainId: 8453, origin: 'https://uniswap-airdrop-claim.xyz', tokens: [{ address: RANDOM, symbol: 'USDC', name: 'USD Coin' }] }, expect: { site_imitates_brand: true, site_lure: true, token_0_impersonates: true } },
  { name: 'official site, own token', input: { chainId: 8453, origin: 'https://app.uniswap.org', tokens: [{ address: RANDOM, symbol: 'PEPE', name: 'Pepe' }] }, expect: { site_imitates_brand: false, site_lure: false, token_0_impersonates: false } },
  { name: 'fake Permit2 signature', input: { chainId: 1, domain: { name: 'Permit2', verifyingContract: RANDOM } }, expect: { domain_impersonates: true } },
  { name: 'unknown game, own token', input: { chainId: 8453, origin: 'https://myfarmgame.net', tokens: [{ address: RANDOM, symbol: 'FARM', name: 'Farm Token' }] }, expect: { site_imitates_brand: false, site_lure: false, token_0_impersonates: false } },
  { name: 'wallet "verify" lookalike', input: { chainId: 1, origin: 'https://metamask-verify-wallet.com' }, expect: { site_imitates_brand: true, site_lure: true } },
];

// 3. Doctor's triage: findings that reach Claude (Jev faked as unsure).
const triageSamples = [
  { name: 'facilitator down', url: 'https://api.weatherfeed402.com/forecast', findings: [{ id: 'settle_failed', message: 'The facilitator named in the 402 did not answer a settle request (timeout after 10 s), so a payment would not complete.' }], expect: { test: false, real: true } },
  { name: 'missing description', url: 'https://data.marketpulse.ai/prices', findings: [{ id: 'description_missing', message: 'The 402 has no description field.' }], expect: { test: false, real: false } },
  { name: 'payTo differs from OpenAPI', url: 'https://api.toolhub.dev/search', findings: [{ id: 'payto_mismatch', message: 'payTo in the 402 (0xAbc…123) differs from the payment address in the OpenAPI document (0xDef…456).' }], expect: { test: false, real: true } },
  { name: 'hello-world sample', url: 'https://x402-hello-world-sample.example-host.net/api/hello', findings: [{ id: 'bazaar_missing', message: 'No discovery metadata in the 402 (bazaar extension missing).' }], expect: { test: true, real: false } },
];

// ---------- run ----------

for (const variant of VARIANTS) {
  for (let r = 0; r < REPEAT; r++) {
    for (const [i, result] of results.entries()) {
      const lang = i % 2 ? 'nl' : 'en';
      current = { route: 'explain', variant, sample: `${result.verdict} #${i + 1} (${lang})` };
      globalThis.fetch = wrapped();
      process.env.CLAUDE_MODEL = variant.model;
      try { await pg.explain(result, lang); } catch (err) { calls.at(-1) && (calls.at(-1).thrown = err.message); }
      globalThis.fetch = realFetch;
    }
    for (const s of jevSamples) {
      const q = jev.buildQuestions(s.input);
      current = { route: 'jev-json', variant, sample: s.name };
      const out = await jev.askClaude(q, Object.keys(q.questions), { env: { ANTHROPIC_API_KEY: KEY, CLAUDE_MODEL: variant.model }, fetch: wrapped() });
      const rec = calls.at(-1);
      rec.answers = out;
      rec.right = Object.entries(s.expect).filter(([k, v]) => out[k] === v).length;
      rec.asked = Object.keys(s.expect).length;
    }
    for (const s of triageSamples) {
      current = { route: 'doctor-triage', variant, sample: s.name };
      const triage = createTriage({ apiKey: 'fake', anthropicKey: KEY, claudeModel: variant.model, fetch: wrapped({ answers: { test_service: { noul: 0.5 }, real_problem: { noul: 0.5 } } }), log: { warn() {} } });
      const before = calls.length;
      const out = await triage.judge({ url: s.url, findings: s.findings });
      if (calls.length === before) { calls.push({ route: 'doctor-triage', variant: variant.id, sample: s.name, skipped: out?.decidedBy }); continue; }
      const rec = calls.at(-1);
      // Claude's own { test, real }, as the code parses it (the verdict text hides `real` when `test` is true).
      let c = null;
      try { const j = JSON.parse(rec.text.slice(rec.text.indexOf('{'), rec.text.lastIndexOf('}') + 1)); if (typeof j.test === 'boolean' && typeof j.real === 'boolean') c = j; } catch {}
      if (out?.decidedBy !== 'jev+claude') c = null;
      rec.answers = c;
      rec.right = c ? Number(c.test === s.expect.test) + Number(c.real === s.expect.real) : 0;
      rec.asked = 2;
    }
  }
}

// ---------- report ----------

const ok = (c) => {
  if (c.skipped) return null;
  if (c.route === 'explain') return Boolean(c.text) && !c.thrown;
  return c.answers && Object.keys(c.answers).length > 0;
};
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const lines = ['# Claude model comparison: presign-guard and Doctor', '', `${REPEAT} runs per sample. Latency is the whole HTTP call. Cost per 1,000 calls from the tokens used.`, ''];
for (const route of ['explain', 'jev-json', 'doctor-triage']) {
  lines.push(`## ${route}`, '', '| Variant | Calls | Usable answer | Right answers | Median ms | p90 ms | Stop reasons | Output tokens (mean) | $ per 1,000 calls |', '|---|---|---|---|---|---|---|---|---|');
  for (const v of VARIANTS) {
    const cs = calls.filter((c) => c.route === route && c.variant === v.id && !c.skipped);
    if (!cs.length) { lines.push(`| ${v.label} | 0 | | | | | | | |`); continue; }
    const ms = cs.map((c) => c.ms || 0);
    const stops = Object.entries(cs.reduce((m, c) => ({ ...m, [c.stop || c.error || 'none']: (m[c.stop || c.error || 'none'] || 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ');
    const right = cs.reduce((a, c) => a + (c.right || 0), 0), asked = cs.reduce((a, c) => a + (c.asked || 0), 0);
    const cost = cs.reduce((a, c) => a + ((c.inTok || 0) * v.price[0] + (c.outTok || 0) * v.price[1]) / 1e6, 0) / cs.length * 1000;
    lines.push(`| ${v.label} | ${cs.length} | ${pct(cs.filter(ok).length, cs.length)} | ${route === 'explain' ? 'read below' : `${right}/${asked}`} | ${q(ms, 0.5)} | ${q(ms, 0.9)} | ${stops} | ${Math.round(cs.reduce((a, c) => a + (c.outTok || 0), 0) / cs.length)} | ${cost.toFixed(2)} |`);
  }
  const skipped = calls.filter((c) => c.route === route && c.skipped);
  if (skipped.length) lines.push('', `Not sent to Claude (decided by the code first): ${[...new Set(skipped.map((c) => `${c.sample} (${c.skipped})`))].join('; ')}.`);
  lines.push('');
}
lines.push('## Explanations side by side (first run)', '');
for (const [i, result] of results.entries()) {
  const lang = i % 2 ? 'nl' : 'en';
  lines.push(`### ${result.verdict} #${i + 1} (${lang})`, '');
  for (const v of VARIANTS) {
    const c = calls.find((x) => x.route === 'explain' && x.variant === v.id && x.sample === `${result.verdict} #${i + 1} (${lang})`);
    lines.push(`**${v.label}** (${c?.ms ?? '?'} ms, ${c?.stop ?? c?.error ?? '?'}): ${c?.text ? c.text.replace(/\s+/g, ' ') : `_no text${c?.thrown ? `: ${c.thrown}` : ''}_`}`, '');
  }
}
lines.push('## Wrong JSON answers', '');
for (const c of calls.filter((x) => x.route !== 'explain' && x.asked && x.right < x.asked)) {
  lines.push(`- ${c.route} / ${c.variant} / ${c.sample}: got ${JSON.stringify(c.answers)}${c.stop ? ` (stop ${c.stop}, ${c.types})` : ''}${c.error ? ` (${c.error})` : ''}`);
}
const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
