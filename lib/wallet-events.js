'use strict';

// ERC-8478 rule wallet-set-at needs the latest ERC-8004 MetadataSet event for an agent's "agentWallet" key at or before
// block B. Free public nodes serve eth_getLogs only over short block ranges (Tenderly's public Base gateway: 1,000
// blocks), so the log is read in chunks from the delegation's walletSetAt up to B, and what was read is kept per
// agent: later checks read only the new blocks. A node that serves any range (PAYEE_LOGS_RPC_URL, e.g. a paid plan)
// is asked in one call instead. A read that would take longer than `budget` chunks goes on in the background, and the
// check answers not-read (wallet-event) until it is done.

const { METADATA_SET_TOPIC, AGENT_WALLET_KEY_TOPIC } = require('./payee');

const PUBLIC_LOGS_RPC = { 'eip155:8453': 'https://base.gateway.tenderly.co' };

// `seed`: what was already read, { "<network>:<registry lower case>:<agentId>": { from, to, latest } }, so a restart
// doesn't read months of history again (lib/agent-wallet-events.json, our own agents).
function createWalletEvents({ rpcUrlFor, logsRpcUrl = process.env.PAYEE_LOGS_RPC_URL || null, chunk = 1000, budget = 40, fetchImpl = fetch, log = console, seed = {} } = {}) {
  const cache = new Map(Object.entries(seed)); // key -> { from, to, latest: { block, data } | null }
  const running = new Map(); // key -> promise of a background read
  let id = 0;
  async function call(url, method, params) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15000) });
        const body = await res.json();
        if (!body.error) return body.result;
        last = new Error(body.error.message || 'rpc error');
      } catch (err) {
        last = err;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw last;
  }
  const filter = (identity, from, to) => [{
    address: identity.registry,
    topics: [METADATA_SET_TOPIC, `0x${BigInt(identity.agentId).toString(16).padStart(64, '0')}`, AGENT_WALLET_KEY_TOPIC],
    fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
  }];
  const lastOf = (logs) => {
    const list = (logs || []).filter((l) => !l.removed).sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
    const l = list[list.length - 1];
    return l ? { block: parseInt(l.blockNumber, 16), data: l.data } : null;
  };

  // Reads [from, to] in chunks; returns the latest event in it, or null.
  async function scan(url, identity, from, to, maxChunks = Infinity) {
    let latest = null, at = from, n = 0;
    while (at <= to) {
      if (n >= maxChunks) return { latest, next: at };
      const end = Math.min(at + chunk - 1, to);
      const found = lastOf(await call(url, 'eth_getLogs', filter(identity, at, end)));
      if (found) latest = found;
      at = end + 1;
      n++;
    }
    return { latest, next: null };
  }

  // The latest event in [from, B], or null when there is none; throws when it can't be read (yet).
  async function walletEvent(identity, from) {
    const B = identity.block;
    if (!(from >= 0) || from > B) return null;
    if (logsRpcUrl) return lastOf(await call(logsRpcUrl, 'eth_getLogs', filter(identity, from, B)));
    const url = PUBLIC_LOGS_RPC[identity.network] || rpcUrlFor(identity.network);
    if (!url) throw new Error(`no node for ${identity.network}`);
    const key = `${identity.network}:${identity.registry.toLowerCase()}:${identity.agentId}`;
    const have = cache.get(key);
    // What's still to read: before what's cached (when this delegation names an earlier block) and after it.
    const ranges = [];
    if (!have) ranges.push([from, B]);
    else {
      if (from < have.from) ranges.push([from, have.from - 1]);
      if (have.to < B) ranges.push([have.to + 1, B]);
    }
    const blocks = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
    const merge = (results) => {
      const now = cache.get(key) || { from, to: from - 1, latest: null };
      let latest = now.latest;
      for (const r of results) if (r && (!latest || r.block > latest.block)) latest = r;
      cache.set(key, { from: Math.min(now.from, from), to: Math.max(now.to, B), latest });
    };
    if (blocks > chunk * budget) {
      if (!running.has(key)) {
        running.set(key, (async () => {
          try {
            const found = [];
            for (const [a, b] of ranges) found.push((await scan(url, identity, a, b)).latest);
            merge(found);
          } catch (err) {
            log.warn?.(`[payee] agent wallet history of ${key} not read: ${String(err?.message || err).slice(0, 120)}`);
          } finally {
            running.delete(key);
          }
        })());
      }
      throw new Error(`still reading ${blocks} blocks of the agent wallet's history`);
    }
    const found = [];
    for (const [a, b] of ranges) found.push((await scan(url, identity, a, b)).latest);
    merge(found);
    const latest = cache.get(key).latest;
    return latest && latest.block >= from && latest.block <= B ? latest : null;
  }

  // The block in which the identity's current agent wallet was set (a delegation's walletSetAt): the first block
  // from which getAgentWallet returns it (a binary search over historical eth_call), then the latest setting event
  // from there on, which also catches a wallet rotated away and back. Throws while the history is still being read.
  walletEvent.walletSetAt = async function walletSetAt(identity) {
    const url = PUBLIC_LOGS_RPC[identity.network] || rpcUrlFor(identity.network);
    const data = `0x00339509${BigInt(identity.agentId).toString(16).padStart(64, '0')}`;
    const walletAt = async (b) => `0x${String(await call(url, 'eth_call', [{ to: identity.registry, data }, `0x${b.toString(16)}`])).slice(-40)}`.toLowerCase();
    const want = String(identity.agentWallet).toLowerCase();
    const key = `${identity.network}:${identity.registry.toLowerCase()}:${identity.agentId}`;
    const known = cache.get(key)?.latest;
    let lo;
    if (known && (await walletAt(known.block)) === want) lo = known.block;
    else {
      let a = 1, b = identity.block;
      while (a < b) { const mid = Math.floor((a + b) / 2); if ((await walletAt(mid)) === want) b = mid; else a = mid + 1; }
      lo = a;
    }
    const ev = await walletEvent(identity, lo);
    if (!ev) throw new Error(`no agent wallet setting event from block ${lo}`);
    return ev.block;
  };
  return walletEvent;
}

module.exports = { createWalletEvents, PUBLIC_LOGS_RPC };
