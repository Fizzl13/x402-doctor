// Output for the GitHub Action (action.yml, bin/action.js): a Markdown job
// summary, workflow-command annotations and the overall result across URLs.

'use strict';

const ICON = { pass: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };
const RANK = { pass: 0, warn: 1, fail: 2 };

// Worst result across the reports; an URL that could not be checked counts as fail.
function overallOf(results) {
  let worst = 'pass';
  for (const r of results) {
    const o = r.error ? 'fail' : r.report.overall;
    if ((RANK[o] ?? 2) > RANK[worst]) worst = o;
  }
  return worst;
}

// Table cells: no pipes or newlines, which would break the Markdown table.
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

// Only URLs anyone can reach get a badge: the badge is drawn by the hosted Doctor.
function isPublic(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host.includes(':') && (host === '::1' || /^(f[cd]|fe80)/i.test(host))) return false;
  return true;
}

function markdownSummary(results, { webUrl = 'https://x402-doctor.fizzl.eu' } = {}) {
  const lines = [`## x402 Doctor: ${ICON[overallOf(results)]} ${overallOf(results)}`, ''];
  for (const { url, report, error } of results) {
    if (error) {
      lines.push(`### ❌ ${url}`, '', `Could not run the checks: ${cell(error)}`, '');
      continue;
    }
    const count = (s) => report.checks.filter((c) => c.status === s).length;
    lines.push(`### ${ICON[report.overall]} ${url}${report.method ? ` (${report.method})` : ''}`, '');
    lines.push(`${count('pass')} passed · ${count('warn')} warnings · ${count('fail')} failed`, '');
    const problems = report.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
    if (problems.length) {
      lines.push('| | Check | What is wrong | How to fix |', '| --- | --- | --- | --- |');
      for (const c of problems) lines.push(`| ${ICON[c.status]} | \`${cell(c.id)}\` | ${cell(c.message)} | ${cell(c.hint)} |`);
      lines.push('');
    }
    const passed = report.checks.filter((c) => c.status === 'pass' || c.status === 'info');
    if (passed.length) {
      lines.push('<details><summary>Passed checks and notes</summary>', '');
      for (const c of passed) lines.push(`- ${ICON[c.status]} ${cell(c.message)}`);
      lines.push('', '</details>', '');
    }
  }
  const badges = results.filter((r) => !r.error && r.report.overall !== 'fail' && isPublic(r.url));
  if (badges.length) {
    lines.push('<details><summary>Show buyers it works: a live badge for your README or site</summary>', '');
    for (const { url } of badges) {
      const q = encodeURIComponent(url);
      lines.push('```markdown', `[![x402 payable](${webUrl}/badge.svg?url=${q})](${webUrl}/trust?url=${q})`, '```', '');
    }
    lines.push('</details>', '');
  }
  lines.push(`Checked by [x402 Doctor](${webUrl}). Read-only: no wallet, no payment.`);
  return `${lines.join('\n')}\n`;
}

// ::error / ::warning lines, which GitHub shows on the run and the PR.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function annotations(results) {
  const out = [];
  for (const { url, report, error } of results) {
    if (error) {
      out.push(`::error title=${escapeProp(`x402 Doctor: ${url}`)}::${escapeData(`Could not run the checks: ${error}`)}`);
      continue;
    }
    for (const c of report.checks) {
      if (c.status !== 'fail' && c.status !== 'warn') continue;
      const level = c.status === 'fail' ? 'error' : 'warning';
      out.push(`::${level} title=${escapeProp(`x402 Doctor ${c.id}: ${url}`)}::${escapeData(c.hint ? `${c.message} Fix: ${c.hint}` : c.message)}`);
    }
  }
  return out;
}

// The URLs input: one per line or comma separated, blank lines and # comments skipped.
function parseUrls(input) {
  return String(input || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

function exitCodeFor(overall, failOn) {
  if (failOn === 'never') return 0;
  if (failOn === 'warn') return overall === 'pass' ? 0 : 1;
  return overall === 'fail' ? 1 : 0;
}

module.exports = { overallOf, markdownSummary, annotations, parseUrls, exitCodeFor };
