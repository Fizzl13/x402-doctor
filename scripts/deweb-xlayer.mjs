#!/usr/bin/env node
// Publishes Fizzl's on-chain website (deweb/out, built by scripts/deweb-site.mjs) on X Layer through TapeOut DeWEB,
// with the deploy wallet in XLAYER_DEPLOY_KEY (a dedicated wallet; it holds only the OKB for these steps).
//
// The steps, each skipped when the chain already shows it done (the state file remembers the processor):
//   1. createCPU on the TapeOut factory: our processor "Fizzl" (deployFee, 0.0066 OKB on 27 Oct 2026), mint price 0.
//   2. mint one NAND transistor (protocolFee, 0.00066 OKB) and tape out circuit #1, a single NAND gate (0.0013 OKB).
//   3. open the circuit's container, its ERC-6551 account (opener FEE, 0.08 OKB).
//   4. write each file to SiteRegistry: putFile with the first 24,000 bytes, appendChunk for the rest, with its
//      SHA-256 so browsers can check what they read. A file whose hash and chunk count already match is skipped.
//   5. bind the on-chain name <circuit>.2.<processor number>.tape (DomainBinding; monthlyFee was 0 on X Layer).
// Every transaction is simulated first (eth_call); --dry-run instead simulates the whole sequence in one
// eth_simulateV1 call from the deploy address with 1 OKB of balance, so nothing is sent and no OKB is needed.
// Addresses and interfaces: TapeKit (github.com/TapeOutProtocol/TapeKit) SPEC Appendix B and kernel/src/config.js.
//
//   node scripts/deweb-xlayer.mjs [--dir deweb/out] [--state deweb-state.json] [--dry-run] [--address 0x…]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, fallback, getContractAddress, http, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { xLayer } from 'viem/chains';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const DRY = process.argv.includes('--dry-run');
// OKX's own node first for reads, sends and receipts (dRPC's free plan failed a receipt lookup on 27 Oct 2026), dRPC
// second; the dry run needs dRPC, the only public X Layer node that runs eth_simulateV1.
const RPCS = (process.env.XLAYER_RPC_URL ? [process.env.XLAYER_RPC_URL] : []).concat(['https://rpc.xlayer.tech', 'https://xlayer.drpc.org']);
const SIM_RPC = 'https://xlayer.drpc.org';
const transport = () => fallback(RPCS.map((url) => http(url, { retryCount: 4, retryDelay: 1500 })));

export const TAPEOUT = {
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  opener: '0x536add8f30f03b69f6fbf29d425a816a0dc50106',
  registry: '0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6',
  binding: '0x68809fd2fb343aa57d0aeb7f33defe477c9666f9',
};
export const CHUNK = 24000;
const AREA = 2; // X Layer's chain code in TapeOut names
const NAND = 0n;
// One NAND gate: inputs are signals 2 and 3, the output is the new signal 4 (op 0x00, a:u24, b:u24).
export const NETLIST = '0x00000002000003';

const ABI = parseAbi([
  'function deployFee() view returns (uint256)',
  'function cpuCount() view returns (uint256)',
  'function cpuAt(uint256) view returns (address)',
  'function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable returns (address, address)',
  'event CPUCreated(address indexed circuits, address indexed transistors, address indexed creator, string name, uint256 supply, uint256 mintPrice)',
  'function protocolFee() view returns (uint256)',
  'function mint(uint256 id, uint256 amount) payable',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
  'function ownerOf(uint256) view returns (address)',
  'function transistors() view returns (address)',
  'function creator() view returns (address)',
  'function nextId() view returns (uint256)',
  'function name() view returns (string)',
  'function FEE() view returns (uint256)',
  'function open(address circuits, uint256 tokenId) payable',
  'function accountOf(address circuits, uint256 tokenId) view returns (address)',
  'function isOpened(address circuits, uint256 tokenId) view returns (bool)',
  'function fileInfo(address container, string path) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)',
  'function putFile(address container, string path, string contentType, bytes32 sha256Hash, bytes data)',
  'function appendChunk(address container, string path, uint256 expectIndex, bytes data)',
  'function monthlyFee() view returns (uint256)',
  'function isLive(string name, address container) view returns (bool)',
  'function bind(string name, address container, uint256 months) payable',
]);

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

// The site's files: [{ path, contentType, sha256, chunks: [hex] }], index.html first.
export function siteFiles(dir) {
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b))).map((f) => {
    const bytes = fs.readFileSync(path.join(dir, f));
    const chunks = [];
    for (let i = 0; i < bytes.length; i += CHUNK) chunks.push(toHex(bytes.subarray(i, i + CHUNK)));
    return { path: f, contentType: TYPES[path.extname(f)] || 'application/octet-stream', sha256: `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length, chunks };
  });
}

export const siteName = (circuitId, processorNumber) => `${circuitId}.${AREA}.${processorNumber}.tape`;
export const gatewayUrl = (circuitId, processorNumber) => `https://${circuitId}-${AREA}-${processorNumber}.tapekit.org`;

const STORY = 'Fizzl checks x402 payments and transactions for AI agents before they pay or sign. This processor holds Fizzl\'s on-chain site on X Layer: every x402 endpoint that takes payment on X Layer, checked daily. https://fizzl.eu';

async function fees(pub) {
  const read = (address, functionName) => pub.readContract({ address, abi: ABI, functionName });
  const [deployFee, openFee, monthlyFee] = await Promise.all([read(TAPEOUT.factory, 'deployFee'), read(TAPEOUT.opener, 'FEE'), read(TAPEOUT.binding, 'monthlyFee')]);
  return { deployFee, openFee, monthlyFee };
}

// The whole sequence as one eth_simulateV1 call, against predicted addresses: the factory creates the Transistors
// proxy and then the Circuits proxy, so they get the factory's next two contract nonces.
async function dryRun(pub, from, files) {
  const { deployFee, openFee, monthlyFee } = await fees(pub);
  const [nonce, cpuCount] = await Promise.all([pub.getTransactionCount({ address: TAPEOUT.factory }), pub.readContract({ address: TAPEOUT.factory, abi: ABI, functionName: 'cpuCount' })]);
  const transistors = getContractAddress({ from: TAPEOUT.factory, nonce: BigInt(nonce) });
  const circuits = getContractAddress({ from: TAPEOUT.factory, nonce: BigInt(nonce) + 1n });
  const protocolFee = await pub.readContract({ address: TAPEOUT.factory, abi: ABI, functionName: 'protocolFee' });
  const tapeoutFee = 1300000000000000n; // TAPEOUT_FEE is a constant of the circuit implementation; read for real in run()
  const container = await pub.readContract({ address: TAPEOUT.opener, abi: ABI, functionName: 'accountOf', args: [circuits, 1n] });
  const name = siteName(1, Number(cpuCount));
  const months = monthlyFee === 0n ? 120n : 1n;
  const call = (label, to, functionName, args, value = 0n) => ({ label, to, data: encodeFunctionData({ abi: ABI, functionName, args }), value });
  const calls = [
    call('createCPU', TAPEOUT.factory, 'createCPU', ['Fizzl', 'FIZZL', STORY, 1000n, 0n], deployFee),
    call('mint NAND', transistors, 'mint', [NAND, 1n], protocolFee),
    call('tapeout', circuits, 'tapeout', [NETLIST, 2, 1], tapeoutFee),
    call('open container', TAPEOUT.opener, 'open', [circuits, 1n], openFee),
    ...files.flatMap((f) => f.chunks.map((chunk, i) => (i === 0
      ? call(`putFile ${f.path}`, TAPEOUT.registry, 'putFile', [container, f.path, f.contentType, f.sha256, chunk])
      : call(`appendChunk ${f.path} #${i}`, TAPEOUT.registry, 'appendChunk', [container, f.path, BigInt(i), chunk])))),
    call(`bind ${name}`, TAPEOUT.binding, 'bind', [name, container, months], months * monthlyFee),
  ];
  const result = await pub.request({
    method: 'eth_simulateV1',
    params: [{ blockStateCalls: [{ stateOverrides: { [from]: { balance: toHex(10n ** 18n) } }, calls: calls.map(({ to, data, value }) => ({ from, to, data, value: toHex(value) })) }], validation: false }, 'latest'],
  });
  let gas = 0n;
  const steps = result[0].calls.map((c, i) => { gas += BigInt(c.gasUsed); return { step: calls[i].label, ok: c.status === '0x1', gas: Number(BigInt(c.gasUsed)), ...(c.error && { error: c.error.message }) }; });
  const value = calls.reduce((s, c) => s + c.value, 0n);
  const gasPrice = await pub.getGasPrice();
  return { from, processor: circuits, processorNumber: Number(cpuCount), container, name, url: gatewayUrl(1, Number(cpuCount)), steps, okb: { fees: Number(value) / 1e18, gas: Number(gas * gasPrice) / 1e18 } };
}

async function run(pub, wallet, from, files, state, save) {
  const send = async (label, address, functionName, args, value = 0n) => {
    const { request } = await pub.simulateContract({ account: wallet.account, address, abi: ABI, functionName, args, value });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 2_000, retryCount: 10 });
    if (receipt.status !== 'success') throw new Error(`${label}: transaction ${hash} failed`);
    console.log(`${label}: ${hash} (${receipt.gasUsed} gas)`);
    return receipt;
  };
  const read = (address, functionName, args = []) => pub.readContract({ address, abi: ABI, functionName, args });
  const { deployFee, openFee, monthlyFee } = await fees(pub);

  // No state file (a run that stopped before saving it): our processor is one of the newest, made by this wallet.
  if (!state.processor) {
    const count = Number(await read(TAPEOUT.factory, 'cpuCount'));
    for (let i = count - 1; i >= Math.max(0, count - 50); i--) {
      const circuits = await read(TAPEOUT.factory, 'cpuAt', [BigInt(i)]);
      const transistors = await read(circuits, 'transistors');
      if ((await read(transistors, 'creator')).toLowerCase() === from.toLowerCase() && (await read(circuits, 'name')) === 'Fizzl') {
        Object.assign(state, { processor: circuits.toLowerCase(), transistors: transistors.toLowerCase(), processorNumber: i });
        console.log(`found our processor #${i} ${circuits}`);
        if (!state.circuitId && (await read(circuits, 'nextId')) > 0n && (await read(circuits, 'ownerOf', [1n])).toLowerCase() === from.toLowerCase()) state.circuitId = 1;
        save();
        break;
      }
    }
  }
  if (!state.processor) {
    const receipt = await send('createCPU', TAPEOUT.factory, 'createCPU', ['Fizzl', 'FIZZL', STORY, 1000n, 0n], deployFee);
    const ev = receipt.logs.map((l) => { try { return decodeEventLog({ abi: ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'CPUCreated');
    if (!ev) throw new Error('createCPU: no CPUCreated event');
    const count = Number(await read(TAPEOUT.factory, 'cpuCount'));
    let number = null;
    for (let i = count - 1; i >= Math.max(0, count - 20); i--) if ((await read(TAPEOUT.factory, 'cpuAt', [BigInt(i)])).toLowerCase() === ev.args.circuits.toLowerCase()) { number = i; break; }
    if (number === null) throw new Error('createCPU: processor not found in cpuAt');
    Object.assign(state, { processor: ev.args.circuits.toLowerCase(), transistors: ev.args.transistors.toLowerCase(), processorNumber: number });
    save();
  }
  if (!state.circuitId) {
    if ((await read(state.transistors, 'balanceOf', [from, NAND])) < 1n) await send('mint NAND', state.transistors, 'mint', [NAND, 1n], await read(TAPEOUT.factory, 'protocolFee'));
    const receipt = await send('tapeout', state.processor, 'tapeout', [NETLIST, 2, 1], await read(state.processor, 'TAPEOUT_FEE'));
    const ev = receipt.logs.map((l) => { try { return decodeEventLog({ abi: ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'TapedOut');
    if (!ev) throw new Error('tapeout: no TapedOut event');
    state.circuitId = Number(ev.args.circuitId);
    save();
  }
  const id = BigInt(state.circuitId);
  if ((await read(state.processor, 'ownerOf', [id])).toLowerCase() !== from.toLowerCase()) throw new Error(`circuit #${id} is not held by ${from}`);
  state.container = (await read(TAPEOUT.opener, 'accountOf', [state.processor, id])).toLowerCase();
  if (!(await read(TAPEOUT.opener, 'isOpened', [state.processor, id]))) await send('open container', TAPEOUT.opener, 'open', [state.processor, id], openFee);
  save();

  for (const f of files) {
    const [, , sha, , chunkCount] = await read(TAPEOUT.registry, 'fileInfo', [state.container, f.path]);
    if (sha.toLowerCase() === f.sha256 && Number(chunkCount) === f.chunks.length) { console.log(`${f.path}: unchanged`); continue; }
    await send(`putFile ${f.path}`, TAPEOUT.registry, 'putFile', [state.container, f.path, f.contentType, f.sha256, f.chunks[0]]);
    for (let i = 1; i < f.chunks.length; i++) await send(`appendChunk ${f.path} #${i}`, TAPEOUT.registry, 'appendChunk', [state.container, f.path, BigInt(i), f.chunks[i]]);
  }

  state.name = siteName(state.circuitId, state.processorNumber);
  state.url = gatewayUrl(state.circuitId, state.processorNumber);
  if (!(await read(TAPEOUT.binding, 'isLive', [state.name, state.container]))) {
    const months = monthlyFee === 0n ? 120n : 1n;
    await send(`bind ${state.name}`, TAPEOUT.binding, 'bind', [state.name, state.container, months], months * monthlyFee);
  }
  state.updated = new Date().toISOString();
  save();
  return state;
}

async function main() {
  const dir = arg('dir', 'deweb/out');
  const statePath = arg('state', 'deweb-state.json');
  const files = siteFiles(dir);
  if (!files.length) throw new Error(`no files in ${dir}`);
  const pub = createPublicClient({ chain: xLayer, transport: DRY ? http(SIM_RPC) : transport() });
  const key = process.env.XLAYER_DEPLOY_KEY;
  const account = key ? privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`) : null;
  const from = account?.address || arg('address', null);
  if (!from) throw new Error('XLAYER_DEPLOY_KEY (or --address for a dry run) is required');
  console.log(`deploy wallet ${from}; files: ${files.map((f) => `${f.path} (${f.size} bytes, ${f.chunks.length} chunks)`).join(', ')}`);

  if (DRY) {
    const sim = await dryRun(pub, from, files);
    for (const s of sim.steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step} (${s.gas} gas)${s.error ? `: ${s.error}` : ''}`);
    console.log(`would publish ${sim.name} at ${sim.url} (processor ${sim.processor}, container ${sim.container}); fees ${sim.okb.fees} OKB + gas ${sim.okb.gas.toFixed(6)} OKB`);
    const balance = await pub.getBalance({ address: from });
    console.log(`balance ${Number(balance) / 1e18} OKB`);
    if (sim.steps.some((s) => !s.ok)) process.exit(1);
    return;
  }
  if (!account) throw new Error('XLAYER_DEPLOY_KEY is required to publish');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  const save = () => fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const wallet = createWalletClient({ account, chain: xLayer, transport: transport() });
  const done = await run(pub, wallet, from, files, state, save);
  console.log(`live: ${done.name} at ${done.url} (container ${done.container})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err.shortMessage || err.message || err); process.exit(1); });
