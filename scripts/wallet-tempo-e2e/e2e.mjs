// One-off: the agent wallet (wallet-mcp 0.7 + guard-wallet 0.7) pays our Tempo acceptance on the Moderato testnet.
// Throwaway keys, faucet tokens only.
import { createRequire } from "node:module";
import http from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient, http as viemHttp, publicActions } from "viem";
import { tempoModerato } from "viem/chains";
import { Actions } from "viem/tempo";
import { configFromEnv, createWallet } from "./lib.js";
const require = createRequire(import.meta.url);
const express = require("express");
const { createMppPay, unlessMppPaid } = require("./mpp-pay.cjs");

const key = generatePrivateKey();
const payer = privateKeyToAccount(key);
const shop = privateKeyToAccount(generatePrivateKey()).address;
const client = createClient({ chain: tempoModerato, transport: viemHttp() }).extend(publicActions);
await Actions.faucet.fundSync(client, { account: payer.address });
console.log("payer", payer.address, "funded; shop", shop);

const mpp = createMppPay({ secret: "e2e-" + Math.random(), realm: "wallet-e2e.test", routes: { "GET /paid": "$0.01" }, tempo: { recipient: shop, chainId: 42431 }, log: { warn: (m) => console.log("server warn", m) } });
const app = express();
app.use(mpp.middleware);
app.use(unlessMppPaid((req, res, next) => (req.path === "/paid" ? res.status(402).json({ error: "payment required" }) : next())));
app.get("/paid", (req, res) => { res.on("finish", () => console.log("served; locals", JSON.stringify(res.locals.mppPayment))); res.json({ ok: true, answer: 42 }); });
const server = await new Promise((r) => { const s = http.createServer(app).listen(0, () => r(s)); });
const url = `http://127.0.0.1:${server.address().port}/paid`;

const wallet = createWallet(configFromEnv({ AGENT_KEY: key, LIMIT_USDC_PER_TX: "1", LIMIT_USDC_PER_DAY: "2", TEMPO_CHAIN: "42431" }));
try {
  console.log("status before", JSON.stringify((await wallet.status()).balances));
  const out = await wallet.payX402({ url, reason: "e2e" });
  console.log("pay result", JSON.stringify({ status: out.status, paid: out.paid, payment: out.payment, body: out.body }));
  console.log("spending", JSON.stringify(await wallet.guard.spending()));
  const shopBal = await Actions.token.getBalance(client, { account: shop, token: "0x20c0000000000000000000000000000000000000" });
  console.log("shop pathUSD raw", String(shopBal?.toString?.() ?? JSON.stringify(shopBal, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
  // Over the per-tx limit (1 USDC) must be refused before anything is sent.
  const mpp2 = createMppPay({ secret: "e2e2", realm: "wallet-e2e.test", routes: { "GET /big": "$1.50" }, tempo: { recipient: shop, chainId: 42431 } });
  const app2 = express(); app2.use(mpp2.middleware); app2.use(unlessMppPaid((req, res) => res.status(402).json({})));
  const s2 = await new Promise((r) => { const s = http.createServer(app2).listen(0, () => r(s)); });
  const big = await wallet.payX402({ url: `http://127.0.0.1:${s2.address().port}/big`, maxPriceUsd: 5 }).then((o) => `UNEXPECTED ${JSON.stringify(o)}`, (e) => `refused: ${e.message}`);
  console.log("over limit:", big);
  s2.close();
} catch (err) {
  console.log("E2E FAILED:", err?.stack || err?.message);
}
server.close();
