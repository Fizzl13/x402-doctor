#!/usr/bin/env node
// Entry point of the GitHub Action (action.yml). Inputs arrive as environment
// variables, never interpolated into a shell. Writes the job summary, the
// annotations and the outputs, and sets the exit code from fail-on.

'use strict';

const fs = require('node:fs');
const { createSafeFetch } = require('../lib/safe-fetch');
const { diagnose } = require('../lib/diagnose');
const { overallOf, markdownSummary, annotations, parseUrls, exitCodeFor } = require('../lib/action-report');

async function main(env = process.env) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 18)) throw new Error(`needs Node 20.18 or newer on the runner (found ${process.versions.node}); add actions/setup-node before this step`);
  const urls = parseUrls(env.DOCTOR_URLS);
  const method = String(env.DOCTOR_METHOD || '').toUpperCase() || undefined;
  const failOn = String(env.DOCTOR_FAIL_ON || 'fail').toLowerCase();
  if (!urls.length) throw new Error('the "urls" input is empty');
  if (method && !['GET', 'POST'].includes(method)) throw new Error('"method" must be GET or POST');
  if (!['fail', 'warn', 'never'].includes(failOn)) throw new Error('"fail-on" must be fail, warn or never');
  for (const url of urls) {
    try {
      new URL(url);
    } catch {
      throw new Error(`not a valid URL: ${url}`);
    }
  }

  // Runs on the caller's runner, so it may check localhost (a dev server started earlier in the job).
  const safeFetch = createSafeFetch({ allowPrivate: true });
  const results = [];
  for (const url of urls) {
    try {
      results.push({ url, report: await diagnose(url, { safeFetch, method }) });
    } catch (err) {
      results.push({ url, error: err.message });
    }
  }

  const overall = overallOf(results);
  for (const line of annotations(results)) console.log(line);
  for (const r of results) console.log(r.error ? `✘ ${r.url}: ${r.error}` : `${r.report.overall.toUpperCase()} ${r.url}`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdownSummary(results));
  if (env.GITHUB_OUTPUT) {
    const report = JSON.stringify(results.map((r) => (r.error ? { url: r.url, error: r.error } : r.report)));
    fs.appendFileSync(env.GITHUB_OUTPUT, `overall=${overall}\nreport<<X402_DOCTOR_EOF\n${report}\nX402_DOCTOR_EOF\n`);
  }
  if (env.DOCTOR_REPORT_FILE) fs.writeFileSync(env.DOCTOR_REPORT_FILE, JSON.stringify(results, null, 2));
  return exitCodeFor(overall, failOn);
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.log(`::error title=x402 Doctor::${String(err.message).replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
    process.exitCode = 2;
  });
}

module.exports = { main };
