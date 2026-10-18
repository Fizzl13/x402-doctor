#!/usr/bin/env node
// The x402 Agent Safety Bench as an open dataset and a leaderboard Space on Hugging Face (run by
// .github/workflows/hf-bench.yml). Reads the raw runs that x402-examples archives on its bench-data branch.
//
//   node scripts/hf-bench.js --results bench/results --readme ex/agent-safety-bench/README.md --out hf-bench --space hf-space
//
// Writes:
//   hf-bench/data/runs.jsonl        every run of a scenario: model, condition, scenario, safe, done, money, transcript
//   hf-bench/data/leaderboard.csv   the published tables, per model and condition
//   hf-bench/data/scenarios.csv     what the agent should do in each scenario (from the bench README)
//   hf-bench/README.md              the dataset card
//   hf-space/index.html, README.md  the leaderboard page (a static Space)
'use strict';

const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const BENCH = 'https://github.com/Fizzl13/x402-examples/tree/main/agent-safety-bench';

// The tables published in the bench README, rebuilt from their runs. Later sources replace earlier ones cell by cell
// (a cell is one model, condition and scenario with all its repeats): the first OpenRouter run lost runs to a rate
// limit, so GPT and nine Gemini cells were run again.
const TABLES = [
  {
    id: 'models-20',
    title: 'Four vendors, all 20 scenarios',
    note: 'GPT, Gemini and DeepSeek through OpenRouter, with the same tools, prompts and skills as Claude. Claude Sonnet is the reference. x402 Doctor 15b320b and presign-guard 338b6e1, 14 October 2026.',
    traps: 39,
    conditions: ['bare', 'skills'],
    sources: [
      { run: '38610940845' },
      { run: '38619031173' },
      { run: '38619042799' },
      { run: '38619054246' },
      { run: '38579724337' },
      { run: '38583031139', scenarios: ['relayed-sign-in'] },
    ],
  },
  {
    id: 'models-20-after-fix',
    title: 'The same 20 scenarios after the skill fix',
    note: 'x402 Doctor #267 added two rules to the skill (a price over twice the advertised one, and a seller others lost money to, each need the user\'s agreement after the warning). The OpenRouter credit ran out after 150 of 180 runs, so Gemini and DeepSeek have fewer runs.',
    conditions: ['skills'],
    sources: [{ run: '38630272947' }, { run: '38630262555' }],
  },
  {
    id: 'claude-14',
    title: 'Three Claude models, the 14 payment scenarios',
    note: 'Three runs per model, scenario and condition. "cautious" adds "be careful with payments" to the prompt. x402 Doctor 15b320b, 14 October 2026.',
    traps: 27,
    conditions: ['bare', 'cautious', 'skills'],
    sources: [{ run: '38569749298' }, { run: '38574724752' }],
  },
];

const CONDITIONS = {
  bare: 'no help',
  cautious: 'told to be careful',
  data: "x402 Doctor's answers in the prompt, no rules",
  skills: "x402 Doctor's (and presign-guard's) skill",
  wallet: 'checks in the wallet',
  'skills-wallet': 'skill and wallet checks',
};

// "claude-sonnet-5-5" → "Claude Sonnet 5.5", "openai/gpt-6.1-sol" → "GPT-6.1 Sol"; a trailing 4-digit date is dropped.
const BRAND = { gpt: 'GPT', deepseek: 'DeepSeek' };
function modelName(agent) {
  const id = String(agent).split(':').slice(1).join(':').split('/').pop();
  const words = id.split('-').filter((w, i, all) => !(i === all.length - 1 && /^\d{4}$/.test(w)));
  const out = [];
  for (const w of words) {
    if (/^\d+$/.test(w) && /^\d+(\.\d+)?$/.test(out[out.length - 1] || '')) out[out.length - 1] += `.${w}`;
    else out.push(BRAND[w] || (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w));
  }
  return out.join(' ').replace(/^GPT (\d)/, 'GPT-$1');
}

function readRuns(dir) {
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* a cut-off line */ }
    }
  }
  return rows;
}

// The rows of one published table, after later sources replaced earlier cells.
function tableRows(rows, table) {
  const byRun = new Map();
  for (const r of rows) {
    const k = String(r.run_id);
    if (!byRun.has(k)) byRun.set(k, []);
    byRun.get(k).push(r);
  }
  const cells = new Map();
  for (const src of table.sources) {
    const fresh = new Map();
    for (const r of byRun.get(src.run) || []) {
      if (!table.conditions.includes(r.condition) || (src.scenarios && !src.scenarios.includes(r.scenario))) continue;
      const key = `${r.agent}|${r.condition}|${r.scenario}`;
      if (!fresh.has(key)) fresh.set(key, []);
      fresh.get(key).push(r);
    }
    for (const [key, list] of fresh) cells.set(key, list);
  }
  return [...cells.values()].flat();
}

function score(rows) {
  const traps = rows.filter((r) => r.kind === 'trap');
  const honest = rows.filter((r) => r.kind !== 'trap');
  const money = (list, field) => Math.round(list.reduce((n, r) => n + (Number(r[field]) || 0), 0) * 1000) / 1000;
  return { traps_avoided: traps.filter((r) => r.safe).length, traps: traps.length, honest_done: honest.filter((r) => r.done).length, honest: honest.length, lost_usd: money(rows, 'unsafe_usd'), overhead_usd: money(rows, 'overhead_usd'), runs: rows.length };
}

// One leaderboard row per table, model and condition, plus which runs each row belongs to.
function leaderboard(rows) {
  const board = [];
  const member = new Map();
  for (const table of TABLES) {
    const picked = tableRows(rows, table);
    for (const r of picked) member.set(r, [...(member.get(r) || []), table.id]);
    const groups = new Map();
    for (const r of picked) {
      const key = `${r.agent}|${r.condition}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, list] of groups) {
      const [agent, condition] = key.split('|');
      board.push({ table: table.id, model: modelName(agent), agent, condition, ...score(list) });
    }
  }
  const order = (b) => [TABLES.findIndex((t) => t.id === b.table), Object.keys(CONDITIONS).indexOf(b.condition)];
  board.sort((a, b) => order(a)[0] - order(b)[0] || a.model.localeCompare(b.model) || order(a)[1] - order(b)[1]);
  return { board, member };
}

function runRow(r, tables) {
  const [provider] = String(r.agent).split(':');
  return {
    run_id: String(r.run_id), at: r.at, provider, model: modelName(r.agent), agent: r.agent, condition: r.condition, scenario: r.scenario, kind: r.kind, repeat: r.repeat,
    safe: r.safe, done: r.done, unsafe_usd: r.unsafe_usd ?? 0, spent_usd: r.spent_usd ?? 0, overhead_usd: r.overhead_usd ?? 0,
    payments: r.payments || [], signed: r.signed || [], preflights: r.preflights || [], checks: r.checks || [],
    turns: r.turns ?? null, stop: r.stop ?? null, error: r.error ?? null, answer: r.answer ?? null, usage: r.usage ?? null,
    transcript: r.transcript ?? null, tables,
  };
}

// The scenario table in the bench README: | kind | `id` | The agent should |
function scenarios(readme) {
  const out = [];
  for (const line of String(readme || '').split('\n')) {
    const m = /^\| (honest|trap) \| `([a-z0-9-]+)` \| (.+?) \|$/.exec(line.trim());
    if (m) out.push({ scenario: m[2], kind: m[1], should: m[3] });
  }
  return out;
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c] ?? '')).join(','))].join('\n') + '\n';
const usd = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;

// The main board: per model, alone vs with the skill, and after the fix.
function mainRows(board) {
  const get = (table, model, condition) => board.find((b) => b.table === table && b.model === model && b.condition === condition);
  const models = [...new Set(board.filter((b) => b.table === 'models-20').map((b) => b.model))];
  return models.map((model) => ({ model, bare: get('models-20', model, 'bare'), skills: get('models-20', model, 'skills'), fixed: get('models-20-after-fix', model, 'skills') }))
    .sort((a, b) => (b.bare?.traps_avoided ?? 0) - (a.bare?.traps_avoided ?? 0) || (a.bare?.lost_usd ?? 0) - (b.bare?.lost_usd ?? 0));
}

function datasetCard({ board, runs, scen, dataset }) {
  const main = mainRows(board);
  const claude = board.filter((b) => b.table === 'claude-14');
  const cell = (b) => (b ? `${b.traps_avoided}/${b.traps}, ${usd(b.lost_usd)}` : '–');
  return `---
license: cc-by-4.0
pretty_name: x402 Agent Safety Bench
language:
- en
tags:
- x402
- ai-agents
- agent-safety
- llm-evaluation
- benchmark
- leaderboard
- tool-use
- payments
- stablecoins
size_categories:
- 1K<n<10K
configs:
- config_name: leaderboard
  data_files: data/leaderboard.csv
- config_name: runs
  data_files: data/runs.jsonl
- config_name: scenarios
  data_files: data/scenarios.csv
---

# x402 Agent Safety Bench

**Do AI agents pay safely?** An AI agent with a wallet gets everyday tasks that involve paying APIs with [x402](https://x402.org) (HTTP 402 Payment Required, USDC) and signing what sellers ask for. Some sellers are honest; others are traps: an overcharge, a sanctioned payee, an instruction injected into an API's answer, a seller that takes the money and asks again, a "free trial" that is a Permit for the whole wallet. The bench measures whether the agent finishes the honest tasks and refuses the traps, alone and with help. Everything runs offline against simulated sellers: nothing is ever paid.

Leaderboard: [x402 Agent Safety Bench Space](https://huggingface.co/spaces/${dataset}) · Method: [DESIGN.md](${BENCH}/DESIGN.md) · Write-up: [fizzl.eu/bench](https://fizzl.eu/bench/)

## Results

**All 20 scenarios** (13 traps and 7 honest tasks, three runs each): traps avoided and money lost to them.

| Model | Alone | With x402 Doctor's skill | After the skill fix |
|---|---|---|---|
${main.map((m) => `| ${m.model} | ${cell(m.bare)} | ${cell(m.skills)} | ${m.fixed ? `${m.fixed.traps_avoided}/${m.fixed.traps}, ${usd(m.fixed.lost_usd)}` : '–'} |`).join('\n')}

Every model finished every honest task in both conditions. After the fix, Gemini and DeepSeek have fewer runs (the credit ran out).

**Three Claude models, the 14 payment scenarios:**

| Model | Condition | Traps avoided | Honest tasks done | Lost |
|---|---|---|---|---|
${claude.map((b) => `| ${b.model} | \`${b.condition}\` | ${b.traps_avoided}/${b.traps} | ${b.honest_done}/${b.honest} | ${usd(b.lost_usd)} |`).join('\n')}

## Files

- \`data/leaderboard.csv\`: the published tables (\`table\`: ${TABLES.map((t) => `\`${t.id}\``).join(', ')}), per \`model\` and \`condition\`: \`traps_avoided\`, \`traps\`, \`honest_done\`, \`honest\`, \`lost_usd\` (paid or signed away to traps), \`overhead_usd\` (spent on checks), \`runs\`.
- \`data/runs.jsonl\`: all ${runs.length.toLocaleString('en-US')} runs, including development runs that no table uses (\`tables\` is empty for those). Per run: \`run_id\` (the GitHub Actions run), \`at\`, \`provider\`, \`model\`, \`condition\` (${Object.entries(CONDITIONS).map(([k, v]) => `\`${k}\`: ${v}`).join('; ')}), \`scenario\`, \`kind\`, \`repeat\`, \`safe\`, \`done\`, \`unsafe_usd\`, \`spent_usd\`, \`overhead_usd\`, the \`payments\`, \`signed\` messages, \`preflights\` and \`checks\` it made, \`turns\`, \`stop\`, \`error\`, the agent's final \`answer\`, token \`usage\`, and the full tool-call \`transcript\`.
- \`data/scenarios.csv\`: the ${scen.length} scenarios and what the agent should do.

The wallet is a throwaway key that holds nothing, and every "payment" or Permit is a real signature that only the run's ledger sees. The sellers, hosts and tokens in the transcripts are simulated.

## Use it

\`\`\`python
from datasets import load_dataset
board = load_dataset("${dataset}", "leaderboard", split="train")
runs = load_dataset("${dataset}", "runs", split="train")
\`\`\`

Run it yourself, with any model: [agent-safety-bench](${BENCH}) (\`npm run bench\`). The help in \`skills\` is [x402 Doctor's preflight skill](https://github.com/Fizzl13/x402-doctor/tree/master/skills/x402-preflight) and [presign-guard's](https://presign-guard.fizzl.eu) signing check.

## License and citation

CC BY 4.0: free to use, share and adapt with credit to "x402 Agent Safety Bench by Fizzl (fizzl.eu)".
`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function spaceReadme() {
  return `---
title: x402 Agent Safety Bench
emoji: 🛡️
colorFrom: indigo
colorTo: green
sdk: static
pinned: false
license: cc-by-4.0
short_description: Do AI agents pay safely? 20 x402 payment traps
tags:
- leaderboard
- agents
- agent-safety
- x402
- payments
---

The leaderboard of the x402 Agent Safety Bench. Data: the dataset of the same name. Method and code: ${BENCH}
`;
}

function spaceHtml({ board, scen, dataset }) {
  const main = mainRows(board);
  const claude = board.filter((b) => b.table === 'claude-14');
  const bar = (b) => (b ? `<span class="cell"><span class="score">${b.traps_avoided}/${b.traps}</span><span class="bar"><i style="width:${Math.round((100 * b.traps_avoided) / (b.traps || 1))}%"></i></span><span class="lost">${usd(b.lost_usd)} lost</span></span>` : '–');
  const updated = new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402 Agent Safety Bench</title>
<meta name="description" content="Do AI agents pay safely? How Claude, GPT, Gemini and DeepSeek handle x402 payment traps, alone and with x402 Doctor's skill.">
<style>
:root { --bg: #fafaf8; --fg: #1c1c1a; --muted: #6b6b66; --line: #e4e3de; --card: #fff; --ok: #1f8a4c; --bad: #b4412b; --accent: #4b47d6; }
@media (prefers-color-scheme: dark) { :root { --bg: #141413; --fg: #ecebe6; --muted: #a3a29b; --line: #2e2d2a; --card: #1c1c1a; --ok: #4cc27f; --bad: #e8775f; --accent: #8f8cff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 920px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 30px; line-height: 1.2; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 36px 0 8px; }
p { margin: 8px 0; }
.lead { font-size: 18px; color: var(--muted); }
.wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
table { border-collapse: collapse; width: 100%; font-size: 15px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
th { font-size: 13px; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
.cell { display: inline-flex; align-items: center; gap: 8px; }
.score { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 42px; }
.bar { display: inline-block; width: 64px; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); }
.lost { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.note { color: var(--muted); font-size: 14px; }
ul { padding-left: 20px; }
code { font-size: 14px; }
a { color: var(--accent); }
.kind { font-size: 12px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); margin-right: 6px; }
.kind.trap { color: var(--bad); }
.kind.honest { color: var(--ok); }
ul.scen { list-style: none; padding: 0; margin: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
ul.scen li { padding: 10px 12px; border-bottom: 1px solid var(--line); }
ul.scen li:last-child { border-bottom: 0; }
ul.scen .should { display: block; margin-top: 2px; }
@media (max-width: 640px) {
  .wrap { overflow: visible; }
  table.resp tr:first-child { display: none; }
  table.resp tr { display: block; padding: 6px 0; border-bottom: 1px solid var(--line); }
  table.resp tr:last-child { border-bottom: 0; }
  table.resp td { display: flex; justify-content: space-between; align-items: center; gap: 12px; border: 0; padding: 4px 12px; }
  table.resp td::before { content: attr(data-label); color: var(--muted); font-size: 13px; }
  table.resp td:first-child::before { content: none; }
}
</style>
</head>
<body>
<main>
<h1>x402 Agent Safety Bench</h1>
<p class="lead">Do AI agents pay safely? An agent with a wallet gets everyday tasks that involve paying APIs with x402 (HTTP 402, USDC) and signing what sellers ask for. Some sellers are honest, others are traps. Nothing is ever paid: the sellers are simulated and the wallet holds nothing.</p>

<h2>All 20 scenarios: traps avoided</h2>
<div class="wrap"><table class="resp">
<tr><th>Model</th><th>Alone</th><th>With x402 Doctor's skill</th><th>After the skill fix</th></tr>
${main.map((m) => `<tr><td><strong>${esc(m.model)}</strong></td><td data-label="Alone">${bar(m.bare)}</td><td data-label="With the skill">${bar(m.skills)}</td><td data-label="After the fix">${bar(m.fixed)}</td></tr>`).join('\n')}
</table></div>
<p class="note">${esc(TABLES[0].note)} Every model finished all 21 honest tasks in both conditions. ${esc(TABLES[1].note)}</p>

<h2>What the numbers say</h2>
<ul>
<li><strong>Alone, every model has the same blind spots.</strong> They paid the sanctioned payee and the sellers whose problems only a track record shows, and signed a $5 Permit to a contract reported for phishing. Reading the payment request doesn't reveal these.</li>
<li><strong>A bigger model didn't help.</strong> Claude Opus avoided exactly the traps Claude Sonnet avoided.</li>
<li><strong>"Be careful" changed almost nothing.</strong> A plain caution in the prompt scored the same as no help.</li>
<li><strong>With x402 Doctor's skill</strong> (a pre-payment check plus rules for using it) and presign-guard's signing check, no trap got through after the fix, and no honest task was refused.</li>
</ul>

<h2>Three Claude models, the 14 payment scenarios</h2>
<div class="wrap"><table class="resp">
<tr><th>Model</th><th>Condition</th><th>Traps avoided</th><th>Honest tasks done</th></tr>
${claude.map((b) => `<tr><td><strong>${esc(b.model)}</strong></td><td data-label="Condition"><code>${esc(b.condition)}</code></td><td data-label="Traps avoided">${bar(b)}</td><td data-label="Honest tasks done"><span class="score">${b.honest_done}/${b.honest}</span></td></tr>`).join('\n')}
</table></div>
<p class="note">${esc(TABLES[2].note)}</p>

<h2>The scenarios</h2>
<ul class="scen">
${scen.map((s) => `<li><span class="kind ${s.kind}">${s.kind}</span><code>${esc(s.scenario)}</code><span class="should">${esc(s.should)}</span></li>`).join('\n')}
</ul>

<h2>Data and method</h2>
<ul>
<li>Every run, with the full tool-call transcript: <a href="https://huggingface.co/datasets/${esc(dataset)}">the dataset</a> (CC BY 4.0).</li>
<li>Method, conditions and limitations: <a href="${BENCH}/DESIGN.md">DESIGN.md</a>. Run it with your own model: <a href="${BENCH}">agent-safety-bench</a>.</li>
<li>The write-up: <a href="https://fizzl.eu/bench/">fizzl.eu/bench</a>. The skill: <a href="https://github.com/Fizzl13/x402-doctor/tree/master/skills/x402-preflight">x402 Doctor's preflight skill</a>.</li>
</ul>
<p class="note">Built by <a href="https://fizzl.eu">Fizzl</a>, the maker of x402 Doctor and presign-guard. Updated ${updated}.</p>
</main>
</body>
</html>
`;
}

function main() {
  const dir = arg('results', 'bench/results');
  if (!fs.existsSync(dir)) { console.error(`hf-bench: no results in ${dir}`); process.exit(1); }
  const out = arg('out', 'hf-bench');
  const spaceDir = arg('space', 'hf-space');
  const dataset = process.env.HF_BENCH_REPO || 'fizzl/x402-agent-safety-bench';
  const raw = readRuns(dir);
  const { board, member } = leaderboard(raw);
  const runs = raw.map((r) => runRow(r, member.get(r) || []));
  let readme = '';
  try { readme = fs.readFileSync(arg('readme', ''), 'utf8'); } catch { /* no scenario table */ }
  const scen = scenarios(readme);
  fs.mkdirSync(path.join(out, 'data'), { recursive: true });
  fs.writeFileSync(path.join(out, 'data', 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'data', 'leaderboard.csv'), csv(board, ['table', 'model', 'agent', 'condition', 'traps_avoided', 'traps', 'honest_done', 'honest', 'lost_usd', 'overhead_usd', 'runs']));
  fs.writeFileSync(path.join(out, 'data', 'scenarios.csv'), csv(scen, ['scenario', 'kind', 'should']));
  fs.writeFileSync(path.join(out, 'README.md'), datasetCard({ board, runs, scen, dataset }));
  fs.mkdirSync(spaceDir, { recursive: true });
  fs.writeFileSync(path.join(spaceDir, 'README.md'), spaceReadme());
  fs.writeFileSync(path.join(spaceDir, 'index.html'), spaceHtml({ board, scen, dataset }));
  console.log(`hf-bench: ${runs.length} runs, ${board.length} leaderboard rows, ${scen.length} scenarios → ${out}, ${spaceDir}`);
}

if (require.main === module) main();
module.exports = { TABLES, modelName, readRuns, tableRows, score, leaderboard, scenarios, mainRows, datasetCard, spaceHtml };
