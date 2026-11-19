// The real Solana facilitator (lib/solana-facilitator.js, @x402/svm's scheme with the Phantom exception) behind the
// seller-facing service, against a mock Solana RPC: a standard agent payment, a Phantom-style payment with Lighthouse
// asserts (also on the fee payer), and a Lighthouse MemoryWrite on the fee payer, which stays refused.
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const kit = require('@solana/kit');
const { createSolanaFacilitator, feePayerOnlyInLighthouseAsserts, LIGHTHOUSE_PROGRAM } = require('../lib/solana-facilitator');
const { createFacilitatorService, USDC_MINT } = require('../lib/facilitator-service');

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const BLOCKHASH = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn';

const rpcState = { methods: [], sent: [], txVersion: 0 };
const servers = [];
let url;
let feePayer;
let payer;
let payTo;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const out = await handler(raw ? JSON.parse(raw) : null);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    }).listen(0, () => resolve(server));
    servers.push(server);
  });
}

async function ata(owner) {
  const enc = kit.getAddressEncoder();
  const [address] = await kit.getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(owner), enc.encode(TOKEN_PROGRAM), enc.encode(USDC_MINT)] });
  return address;
}

const accountInfo = (data) => ({ data: [Buffer.from(data).toString('base64'), 'base64'], executable: false, lamports: 2039280, owner: TOKEN_PROGRAM, rentEpoch: 0, space: data.length });
function mintData() { const m = new Uint8Array(82); m[44] = 6; m[45] = 1; return m; }
function tokenAccountData(owner, amount) {
  const d = new Uint8Array(165);
  d.set(kit.getAddressEncoder().encode(USDC_MINT), 0);
  d.set(kit.getAddressEncoder().encode(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return d;
}

// Enough of a Solana RPC for the facilitator: accounts, simulation, send, confirm, and the parsed transaction.
async function rpc(body) {
  rpcState.methods.push(body.method);
  const ok = (value) => ({ jsonrpc: '2.0', id: body.id, result: value });
  const ctx = { context: { slot: 100 } };
  switch (body.method) {
    case 'getLatestBlockhash': return ok({ ...ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } });
    case 'getAccountInfo': {
      const a = body.params[0];
      if (a === USDC_MINT) return ok({ ...ctx, value: accountInfo(mintData()) });
      if (a === (await ata(payTo))) return ok({ ...ctx, value: accountInfo(tokenAccountData(payTo, 0n)) });
      if (a === (await ata(payer.address))) return ok({ ...ctx, value: accountInfo(tokenAccountData(payer.address, 3_520_810n)) });
      return ok({ ...ctx, value: null });
    }
    case 'getMultipleAccounts': return ok({ ...ctx, value: body.params[0].map(() => null) });
    case 'getBalance': return ok({ ...ctx, value: 1_000_000_000 });
    case 'simulateTransaction': return ok({ ...ctx, value: { err: null, logs: [], accounts: null, unitsConsumed: 12000, returnData: null, innerInstructions: [] } });
    case 'sendTransaction': {
      const tx = kit.getTransactionDecoder().decode(Buffer.from(body.params[0], 'base64'));
      const signature = kit.getBase58Decoder().decode(Object.values(tx.signatures)[0]);
      rpcState.sent.push({ signature, tx });
      return ok(signature);
    }
    case 'getSignatureStatuses': return ok({ ...ctx, value: body.params[0].map(() => ({ slot: 100, confirmations: null, err: null, confirmationStatus: 'confirmed' })) });
    case 'getTransaction': {
      const sent = rpcState.sent.find((t) => t.signature === body.params[0]);
      if (!sent) return ok(null);
      // Like mainnet: asking for an older version than the transaction's is an error (Phantom sends version 1).
      if (!(body.params[1]?.maxSupportedTransactionVersion >= rpcState.txVersion)) {
        return { jsonrpc: '2.0', id: body.id, error: { code: -32015, message: `Transaction version (${rpcState.txVersion}) is not supported by the requesting client.` } };
      }
      const msg = kit.getCompiledTransactionMessageDecoder().decode(sent.tx.messageBytes);
      const keys = msg.staticAccounts;
      const instructions = msg.instructions.map((ix) => {
        const programId = keys[ix.programAddressIndex];
        const data = ix.data ?? new Uint8Array();
        if (programId === TOKEN_PROGRAM && data[0] === 12) {
          const [source, mint, destination, authority] = ix.accountIndices.map((i) => keys[i]);
          const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true).toString();
          return { program: 'spl-token', programId, stackHeight: null, parsed: { type: 'transferChecked', info: { source, mint, destination, authority, tokenAmount: { amount, decimals: data[9] } } } };
        }
        return { programId, accounts: (ix.accountIndices ?? []).map((i) => keys[i]), data: kit.getBase58Decoder().decode(data), stackHeight: null };
      });
      return ok({ slot: 100, blockTime: 0, meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions } } });
    }
    case 'getSlot': return ok(100);
    default: return { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `mock rpc: ${body.method}` } };
  }
}

// A payment transaction: limit, price, [Lighthouse x2], transferChecked, memo, [Lighthouse], partly signed by the payer.
async function paymentTransaction({ lighthouseAccount = null, lighthouseKind = 7 } = {}) {
  const u32 = (n) => { const b = new Uint8Array(5); b[0] = 2; new DataView(b.buffer).setUint32(1, n, true); return b; };
  const u64 = (tag, n) => { const b = new Uint8Array(9); b[0] = tag; new DataView(b.buffer).setBigUint64(1, BigInt(n), true); return b; };
  const transfer = new Uint8Array(10);
  transfer[0] = 12;
  new DataView(transfer.buffer).setBigUint64(1, 20000n, true);
  transfer[9] = 6;
  const lighthouse = (size) => ({ programAddress: LIGHTHOUSE_PROGRAM, accounts: [{ address: lighthouseAccount, role: kit.AccountRole.READONLY }], data: new Uint8Array(size).fill(lighthouseKind) });
  const transferIx = {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: await ata(payer.address), role: kit.AccountRole.WRITABLE },
      { address: USDC_MINT, role: kit.AccountRole.READONLY },
      { address: await ata(payTo), role: kit.AccountRole.WRITABLE },
      { address: payer.address, role: kit.AccountRole.READONLY_SIGNER },
    ],
    data: transfer,
  };
  const memo = { programAddress: MEMO_PROGRAM, accounts: [], data: new TextEncoder().encode('00112233445566778899aabbccddeeff') };
  const budget = [{ programAddress: COMPUTE_BUDGET, accounts: [], data: u32(28460) }, { programAddress: COMPUTE_BUDGET, accounts: [], data: u64(3, 1) }];
  const instructions = lighthouseAccount ? [...budget, lighthouse(52), lighthouse(16), transferIx, memo, lighthouse(27)] : [...budget, transferIx, memo];
  const message = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m) => kit.setTransactionMessageFeePayer(feePayer, m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000n }, m),
    (m) => kit.appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await kit.partiallySignTransaction([payer.keyPair], kit.compileTransaction(message));
  return kit.getBase64EncodedWireTransaction(signed);
}

function settleBody(transaction) {
  const requirements = { scheme: 'exact', network: SOLANA, asset: USDC_MINT, amount: '20000', payTo, maxTimeoutSeconds: 300, extra: { feePayer } };
  return { x402Version: 2, paymentPayload: { x402Version: 2, resource: { url: 'https://seller.example/paid' }, accepted: requirements, payload: { transaction } }, paymentRequirements: requirements };
}

const post = (path, b) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

before(async () => {
  const feePayerSigner = await kit.generateKeyPairSigner(true);
  feePayer = feePayerSigner.address;
  payer = await kit.generateKeyPairSigner(true);
  payTo = (await kit.generateKeyPairSigner()).address;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', feePayerSigner.keyPair.privateKey));
  const secret = new Uint8Array(64);
  secret.set(pkcs8.slice(-32), 0);
  secret.set(kit.getAddressEncoder().encode(feePayer), 32);
  const rpcServer = await listen(rpc);
  const quiet = { log() {}, error() {} };
  const core = createSolanaFacilitator({ privateKey: kit.getBase58Decoder().decode(secret), rpcUrl: `http://127.0.0.1:${rpcServer.address().port}`, log: quiet });
  const sanctions = { enabled: true, ready: async () => ({}), check: () => ({ listed: false }) };
  const svc = createFacilitatorService({ env: {}, core, sanctions, log: quiet });
  const app = express();
  app.use(svc.router(express));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  servers.push(server);
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => { for (const s of servers) s.close(); });
beforeEach(() => { rpcState.methods = []; rpcState.sent = []; rpcState.txVersion = 0; });

test('supported names our fee payer for Solana mainnet', async () => {
  const sup = await (await fetch(`${url}/facilitator/supported`)).json();
  const kind = sup.kinds.find((k) => k.network === SOLANA);
  assert.ok(kind, JSON.stringify(sup));
  assert.equal(kind.extra.feePayer, feePayer);
});

test('a standard agent payment verifies and settles: fee payer co-signs, the payer signature is kept', async () => {
  const tx = await paymentTransaction();
  const v = await (await post('/facilitator/verify', settleBody(tx))).json();
  assert.equal(v.isValid, true, JSON.stringify(v));
  assert.equal(v.payer, payer.address);
  const r = await post('/facilitator/settle', settleBody(tx));
  const out = await r.json();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(rpcState.sent.length, 1);
  assert.ok(rpcState.sent[0].tx.signatures[feePayer], 'fee payer co-signed');
  assert.ok(rpcState.sent[0].tx.signatures[payer.address], 'payer signature kept');
  assert.equal(out.transaction, rpcState.sent[0].signature);
});

test('a Phantom-style payment with Lighthouse asserts, also on the fee payer, settles', async () => {
  rpcState.txVersion = 1; // Phantom's transactions read back as version 1 on mainnet (18 Nov 2026)
  const tx = await paymentTransaction({ lighthouseAccount: feePayer, lighthouseKind: 5 });
  const out = await (await post('/facilitator/settle', settleBody(tx))).json();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(rpcState.sent.length, 1);
  assert.ok(rpcState.methods.includes('simulateTransaction'), 'simulated before sending');
});

test('a Lighthouse MemoryWrite on the fee payer is refused and nothing is sent', async () => {
  const tx = await paymentTransaction({ lighthouseAccount: feePayer, lighthouseKind: 0 });
  const out = await (await post('/facilitator/settle', settleBody(tx))).json();
  assert.equal(out.success, false);
  assert.match(out.errorReason, /lighthouse|fee_payer/);
  assert.equal(rpcState.sent.length, 0);
});

test('fee payer isolation: only Lighthouse asserts may name the fee payer', () => {
  const fp = 'FeePayer1111111111111111111111111111111111';
  const ix = (programAddress, kind, address = fp) => ({ programAddress, accounts: [{ address }], data: Uint8Array.of(kind) });
  assert.equal(feePayerOnlyInLighthouseAsserts([ix(LIGHTHOUSE_PROGRAM, 2), ix(LIGHTHOUSE_PROGRAM, 17), ix(TOKEN_PROGRAM, 12, 'Other111')], fp), true);
  assert.equal(feePayerOnlyInLighthouseAsserts([ix(LIGHTHOUSE_PROGRAM, 0)], fp), false);
  assert.equal(feePayerOnlyInLighthouseAsserts([ix(LIGHTHOUSE_PROGRAM, 18)], fp), false);
  assert.equal(feePayerOnlyInLighthouseAsserts([ix(TOKEN_PROGRAM, 12)], fp), false);
});
