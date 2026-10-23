// scripts/jev-check.js: the report shows the verdict, the reasons, Jev's raw scores next to their bars, and says
// so when a check gave no answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { report } = require('../scripts/jev-check');

test('report: verdict, reasons, bait scores and price comparison', () => {
  const md = report('https://api.example.com/x', { verdict: 'caution', reasons: [{ level: 'caution', code: 'price_high', message: 'Costs $1.' }] }, {
    bait: { impersonation: 0.12, lure: 0.03, mismatch: null },
    price: { price_usd: 1, comparable_median_usd: 0.01, comparables: 7, ratio: 100, range_usd: [0.005, 0.05], cheaper: [{ url: 'https://b.example/y', price_usd: 0.01, description: 'Same thing' }] },
  });
  assert.match(md, /Preflight verdict: \*\*caution\*\*/);
  assert.match(md, /- caution `price_high`: Costs \$1\./);
  assert.match(md, /- impersonation: 0\.12 \(bar 0\.85\)/);
  assert.match(md, /- mismatch: not asked/);
  assert.match(md, /100x the median of \$0\.01 across 7 comparable services/);
  assert.match(md, /cheaper: https:\/\/b\.example\/y \(\$0\.01\): Same thing/);
});

test('report: no answer from either check', () => {
  const md = report('https://api.example.com/x', { verdict: 'go', reasons: [] }, {});
  assert.match(md, /### Bait check[^\n]*\n\nNo answer/);
  assert.match(md, /### Price check[^\n]*\n\nNo answer/);
});
