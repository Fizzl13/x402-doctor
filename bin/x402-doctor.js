#!/usr/bin/env node
// x402-doctor CLI: diagnose an x402 endpoint from a terminal or CI.
//
//   x402-doctor https://api.example.com/paid
//   x402-doctor https://api.example.com/paid --method POST
//   x402-doctor http://localhost:3002/signal/BTC-USDT --json
//
// Exit code: 0 pass/warn, 1 when a check fails, 2 on usage errors.
// Unlike the web service, the CLI may diagnose localhost (it runs on your machine).

const { createSafeFetch } = require('../lib/safe-fetch');
const { diagnose } = require('../lib/diagnose');

function usage(message) {
  if (message) console.error(`x402-doctor: ${message}\n`);
  console.error('usage: x402-doctor <url> [--method GET|POST] [--json] [--strict]');
  console.error('  --strict   exit 1 on warnings too');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--method') args.method = String(argv[++i] || '').toUpperCase();
    else if (a === '--help' || a === '-h') usage();
    else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else if (!args.url) args.url = a;
    else usage('only one URL');
  }
  if (!args.url) usage('missing url');
  if (args.method && !['GET', 'POST'].includes(args.method)) usage('--method must be GET or POST');
  return args;
}

const ICON = { pass: '✔', warn: '!', fail: '✘', info: 'i' };

function print(report) {
  console.log(`x402 doctor · ${report.url}${report.method ? ` (${report.method})` : ''}\n`);
  let group = null;
  for (const c of report.checks) {
    if (c.group !== group) {
      group = c.group;
      console.log(`${String(group || 'other').toUpperCase()}`);
    }
    console.log(`  ${ICON[c.status] || '?'} ${c.message}`);
    if (c.hint && c.status !== 'pass') console.log(`      → ${c.hint}`);
  }
  const count = (s) => report.checks.filter((c) => c.status === s).length;
  console.log(`\n${report.overall.toUpperCase()}: ${count('pass')} passed, ${count('warn')} warnings, ${count('fail')} failed`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await diagnose(args.url, { safeFetch: createSafeFetch({ allowPrivate: true }), method: args.method });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else print(report);
  process.exitCode = report.overall === 'fail' || (args.strict && report.overall === 'warn') ? 1 : 0;
}

main().catch((err) => {
  console.error(`x402-doctor: ${err.message}`);
  process.exitCode = 2;
});
