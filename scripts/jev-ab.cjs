// Temporary: Fizzl Buy dry run with the real keys (not for merging).
const { execFileSync } = require('node:child_process');
const needs = ['weather forecast for Amsterdam tomorrow', 'current BTC price in USD', 'search the web for news about the x402 payment protocol', 'latest crypto news headlines', 'convert 100 EUR to USD', 'is the token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on Base safe to buy', 'translate "good morning, how are you" to Spanish'];
process.stdout.write(execFileSync(process.execPath, ['scripts/buy-dry-run.js', ...needs], { encoding: 'utf8', env: process.env, timeout: 600000 }));
