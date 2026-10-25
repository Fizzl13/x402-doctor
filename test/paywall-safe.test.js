// The browser paywall embeds the request URL and descriptions in an inline <script> (x402-foundation/x402#3852):
// lib/paywall-safe.js makes sure nothing from the request can end that script. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createPaywall, evmPaywall, svmPaywall } = require('@x402/paywall');
const { scriptSafe, scriptSafePaywall } = require('../lib/paywall-safe');

const accepts = [{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000', payTo: '0x6B0F4651eD42893ab58139938175E4a69f175F25', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }];
const ATTACK = '</script><script>window.__injected=1</script>';
const paywallOf = () => createPaywall().withNetwork(evmPaywall).withNetwork(svmPaywall).withConfig({ appName: 'x402 Doctor', testnet: false }).build();

// window.x402 as the page's own config script sets it.
function configOf(html) {
  const start = html.indexOf('window.x402 = {');
  assert.ok(start > 0, 'the config script is there');
  const sandbox = { window: {}, console: { log() {} } };
  vm.runInNewContext(html.slice(start, html.indexOf('</script>', start)), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.x402));
}

test('paywall: a raw </script> in the URL or description reaches the page only as data', () => {
  const url = `https://x402-doctor.fizzl.eu/api/v1/diagnose?url=https://example.com/${ATTACK}$'`;
  const pr = { x402Version: 2, error: 'Payment required', resource: { url, description: `Diagnose ${ATTACK}`, mimeType: 'application/json' }, accepts };
  const config = { currentUrl: url, appName: 'x402 Doctor', testnet: false };
  assert.ok(paywallOf().generateHtml(pr, config).includes('<script>window.__injected'), 'the paywall alone lets it through');

  const html = scriptSafePaywall(paywallOf()).generateHtml(pr, config);
  assert.ok(!html.includes('<script>window.__injected'), 'no injected script element');
  const x402 = configOf(html);
  assert.equal(x402.__injected, undefined);
  assert.match(x402.currentUrl, /%3C\/script%3E%3Cscript%3Ewindow\.__injected=1%3C\/script%3E%24%27$/, 'the same URL, percent-encoded');
  assert.match(x402.paymentRequired.resource.url, /%3C\/script%3E/);
  assert.equal(x402.paymentRequired.resource.description, `Diagnose ‹/script>‹script>window.__injected=1‹/script>`);
  assert.deepEqual(x402.paymentRequired.accepts, accepts, 'what the wallet signs is unchanged');
});

test('paywall: ordinary values pass unchanged', () => {
  const pr = { x402Version: 2, resource: { url: 'https://x402-doctor.fizzl.eu/api/v1/preflight?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc', description: 'Is this x402 endpoint safe to pay? $0.001' }, accepts };
  assert.deepEqual(scriptSafe(pr), pr);
  assert.deepEqual(scriptSafe({ currentUrl: 'https://x402-doctor.fizzl.eu/api/v1/fix', testnet: false, amount: 0.01 }), { currentUrl: 'https://x402-doctor.fizzl.eu/api/v1/fix', testnet: false, amount: 0.01 });
  assert.equal(scriptSafe(undefined), undefined);
});
