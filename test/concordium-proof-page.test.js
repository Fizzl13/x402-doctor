// /concordium-proof.html asks the Concordium wallet app on a phone over WalletConnect only when a Reown project id is
// set; the page reads it from /api/v1/concordium/proof-page, and loads WalletConnect from this server.
const test = require('node:test');
const assert = require('node:assert/strict');

async function withApp(env, fn) {
  const { createApp } = require('../server');
  const app = createApp({ env: { USAGE_LOG_TOKEN: '', ...env }, usageReader: { load: async () => ({ events: [] }) } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('the proof page learns whether the phone app can be asked', async () => {
  await withApp({ WALLETCONNECT_PROJECT_ID: ' abc123 ' }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/v1/concordium/proof-page`)).json(), { walletConnect: 'abc123' });
    const wc = await fetch(`${base}/vendor/concordium-wc.js`);
    assert.equal(wc.status, 200);
    assert.match(await wc.text(), /WalletConnectSignClient/);
  });
  await withApp({}, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/v1/concordium/proof-page`)).json(), { walletConnect: null });
  });
});
